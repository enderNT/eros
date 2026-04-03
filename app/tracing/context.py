from __future__ import annotations

import contextvars
from typing import Any, Protocol

from pydantic import BaseModel

from app.tracing.types import TraceEnvelope, TraceFragment, TraceRecord, utc_now


class TraceNormalizer(Protocol):
    def normalize_input(self, payload: Any) -> dict[str, Any]:
        ...

    def normalize_output(self, payload: Any) -> dict[str, Any]:
        ...

    def normalize_error(self, payload: Any) -> dict[str, Any]:
        ...

    def normalize_fragment(self, kind: str, payload: Any) -> dict[str, Any]:
        ...


class PassThroughTraceNormalizer:
    def normalize_input(self, payload: Any) -> dict[str, Any]:
        return _to_dict(payload)

    def normalize_output(self, payload: Any) -> dict[str, Any]:
        return _to_dict(payload)

    def normalize_error(self, payload: Any) -> dict[str, Any]:
        return _to_dict(payload)

    def normalize_fragment(self, kind: str, payload: Any) -> dict[str, Any]:
        del kind
        return _to_dict(payload)


class TraceContext:
    def __init__(self, normalizer: TraceNormalizer | None = None) -> None:
        self._normalizer = normalizer or PassThroughTraceNormalizer()
        self._record: TraceRecord | None = None
        self._next_order = 0

    def start(self, envelope: TraceEnvelope) -> "TraceContext":
        self._record = TraceRecord(envelope=envelope)
        self._next_order = 0
        return self

    def capture_input(self, payload: Any) -> None:
        self._require_started().input_payload = self._normalizer.normalize_input(payload)

    def capture_fragment(
        self,
        kind: str,
        payload: Any,
        order: int | None = None,
        *,
        label: str = "",
        latency_ms: int | None = None,
        token_usage: dict[str, Any] | None = None,
    ) -> None:
        record = self._require_started()
        fragment_order = self._resolve_order(order)
        record.fragments.append(
            TraceFragment(
                kind=kind,
                order=fragment_order,
                label=label,
                payload=self._normalizer.normalize_fragment(kind, payload),
                latency_ms=latency_ms,
                token_usage=token_usage or {},
                created_at=utc_now(),
            )
        )

    def capture_output(self, payload: Any) -> None:
        self._require_started().output_payload = self._normalizer.normalize_output(payload)

    def capture_error(self, error_payload: Any) -> None:
        self._require_started().error_payload = self._normalizer.normalize_error(error_payload)

    def finalize(
        self,
        outcome: str,
        *,
        metrics_payload: dict[str, Any] | None = None,
        tags: dict[str, Any] | None = None,
        extra_payload: dict[str, Any] | None = None,
        projector_eligibility_summary: dict[str, Any] | None = None,
    ) -> TraceRecord:
        record = self._require_started()
        record.outcome = outcome
        record.completed_at = utc_now()
        if metrics_payload is not None:
            record.metrics_payload = _to_dict(metrics_payload)
        if tags is not None:
            record.tags = _to_dict(tags)
        if extra_payload is not None:
            record.extra_payload = _to_dict(extra_payload)
        if projector_eligibility_summary is not None:
            record.projector_eligibility_summary = _to_dict(projector_eligibility_summary)
        return record.model_copy(deep=True)

    def current_record(self) -> TraceRecord | None:
        if self._record is None:
            return None
        return self._record.model_copy(deep=True)

    def _require_started(self) -> TraceRecord:
        if self._record is None:
            raise RuntimeError("TraceContext.start() must be called before capturing trace data.")
        return self._record

    def _resolve_order(self, explicit_order: int | None) -> int:
        if explicit_order is None:
            explicit_order = self._next_order
        self._next_order = max(self._next_order, explicit_order + 1)
        return explicit_order


_current_trace_context: contextvars.ContextVar[TraceContext | None] = contextvars.ContextVar(
    "current_trace_context",
    default=None,
)


def bind_trace_context(trace_context: TraceContext | None) -> contextvars.Token[TraceContext | None]:
    return _current_trace_context.set(trace_context)


def reset_trace_context(token: contextvars.Token[TraceContext | None]) -> None:
    _current_trace_context.reset(token)


def get_trace_context() -> TraceContext | None:
    return _current_trace_context.get()


def _to_dict(payload: Any) -> dict[str, Any]:
    if payload is None:
        return {}
    if isinstance(payload, BaseModel):
        return payload.model_dump(mode="json")
    if isinstance(payload, dict):
        return dict(payload)
    if hasattr(payload, "model_dump"):
        return payload.model_dump(mode="json")
    if hasattr(payload, "dict"):
        return payload.dict()  # type: ignore[no-any-return]
    return {"value": payload}
