from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from uuid import uuid4

from pydantic import BaseModel

from app.models.schemas import ChatwootWebhook
from app.tracing import (
    AllowAllFieldPolicy,
    AsyncBatchTraceSink,
    InMemoryTraceRepository,
    NoopTraceSink,
    PassThroughTraceNormalizer,
    PostgresTraceRepository,
    ProjectedExample,
    TraceContext,
    TraceEnvelope,
    TraceProjector,
)


class ClinicTraceNormalizer(PassThroughTraceNormalizer):
    def normalize_input(self, payload: Any) -> dict[str, Any]:
        if isinstance(payload, ChatwootWebhook):
            return {
                "channel": "chatwoot",
                "conversation_id": payload.conversation_id,
                "contact_id": payload.contact_id,
                "contact_name": payload.contact_name,
                "message": payload.latest_message,
                "event": payload.event,
                "message_type": payload.message_type,
                "account_id": payload.account_id,
            }
        return super().normalize_input(payload)

    def normalize_output(self, payload: Any) -> dict[str, Any]:
        normalized = super().normalize_output(payload)
        if "response_text" in normalized:
            normalized["response_preview"] = str(normalized["response_text"])[:240]
        return normalized

    def normalize_error(self, payload: Any) -> dict[str, Any]:
        if isinstance(payload, Exception):
            return {"type": type(payload).__name__, "message": str(payload)}
        return super().normalize_error(payload)

    def normalize_fragment(self, kind: str, payload: Any) -> dict[str, Any]:
        if isinstance(payload, BaseModel):
            return payload.model_dump(mode="json")
        if isinstance(payload, dict):
            return dict(payload)
        return {"kind": kind, "value": payload}


class ClinicFieldPolicy(AllowAllFieldPolicy):
    _sensitive_keys = {
        "api_key",
        "authorization",
        "token",
        "access_token",
        "refresh_token",
    }

    def apply(self, payload: Any, *, stage: str, section: str) -> Any:
        sanitized = _sanitize(payload)
        if section == "input" and isinstance(sanitized, dict):
            allowed = {
                "channel",
                "conversation_id",
                "contact_id",
                "contact_name",
                "message",
                "event",
                "message_type",
                "account_id",
            }
            return {key: value for key, value in sanitized.items() if key in allowed}
        if stage == "project" and isinstance(sanitized, dict):
            return {key: value for key, value in sanitized.items() if key not in {"response_text", "response_preview"}}
        return sanitized


class RoutingDecisionProjector:
    name = "routing_decision"
    version = "v1"

    def project(self, trace_record) -> list[ProjectedExample]:
        routing_fragment = next((fragment for fragment in trace_record.fragments if fragment.kind == "routing_decision"), None)
        if routing_fragment is None:
            return []
        return [
            ProjectedExample(
                trace_id=trace_record.envelope.trace_id,
                task_name="state_router",
                projector_version=self.version,
                input_payload={
                    "user_message": trace_record.input_payload.get("message", ""),
                    "conversation_id": trace_record.input_payload.get("conversation_id"),
                    "memories": next(
                        (
                            fragment.payload.get("recalled_memories", [])
                            for fragment in trace_record.fragments
                            if fragment.kind == "memory_lookup"
                        ),
                        [],
                    ),
                },
                target_payload={
                    "next_node": routing_fragment.payload.get("next_node"),
                    "intent": routing_fragment.payload.get("intent"),
                    "needs_retrieval": routing_fragment.payload.get("needs_retrieval"),
                },
                metadata_payload={
                    "confidence": routing_fragment.payload.get("confidence"),
                    "reason": routing_fragment.payload.get("reason"),
                    "outcome": trace_record.outcome,
                },
                eligibility_reason="routing-fragment-present",
            )
        ]


class TraceRuntime:
    def __init__(self, sink: AsyncBatchTraceSink | NoopTraceSink, normalizer: ClinicTraceNormalizer) -> None:
        self._sink = sink
        self._normalizer = normalizer

    @property
    def sink(self) -> AsyncBatchTraceSink | NoopTraceSink:
        return self._sink

    def start_turn(self, payload: ChatwootWebhook, *, flow_id: str, settings) -> TraceContext:
        envelope = TraceEnvelope(
            trace_id=uuid4().hex,
            session_key=payload.conversation_id,
            actor_key=payload.contact_id,
            app_key=settings.trace_app_key,
            flow_key=flow_id,
            dedupe_key=f"{payload.conversation_id}:{payload.event}:{payload.message_type}:{payload.latest_message}",
            component_version="clinic-assistant@0.1.0",
            model_backend=settings.resolved_llm_provider,
            model_name=settings.resolved_llm_model,
        )
        return TraceContext(self._normalizer).start(envelope)


@asynccontextmanager
async def build_trace_runtime(settings) -> AsyncIterator[TraceRuntime]:
    normalizer = ClinicTraceNormalizer()
    projectors: list[TraceProjector] = [RoutingDecisionProjector()] if settings.trace_projectors_enabled else []

    if settings.trace_backend == "postgres":
        if not settings.trace_postgres_dsn:
            raise RuntimeError("`trace_postgres_dsn` is required when `trace_backend=postgres`.")
        repository = PostgresTraceRepository(settings.trace_postgres_dsn)
        if settings.trace_postgres_setup_on_start:
            await repository.setup()
        sink = await AsyncBatchTraceSink(
            repository,
            projectors=projectors,
            field_policy=ClinicFieldPolicy(),
            batch_size=settings.trace_batch_size,
            flush_interval_seconds=settings.trace_flush_interval_seconds,
        ).start()
        try:
            yield TraceRuntime(sink, normalizer)
        finally:
            await sink.close()
        return

    if settings.trace_backend == "in_memory":
        repository = InMemoryTraceRepository()
        sink = await AsyncBatchTraceSink(
            repository,
            projectors=projectors,
            field_policy=ClinicFieldPolicy(),
            batch_size=settings.trace_batch_size,
            flush_interval_seconds=settings.trace_flush_interval_seconds,
        ).start()
        try:
            yield TraceRuntime(sink, normalizer)
        finally:
            await sink.close()
        return

    yield TraceRuntime(NoopTraceSink(), normalizer)


def _sanitize(value: Any) -> Any:
    if isinstance(value, BaseModel):
        value = value.model_dump(mode="json")
    if isinstance(value, dict):
        sanitized: dict[str, Any] = {}
        for key, inner_value in value.items():
            if str(key).lower() in ClinicFieldPolicy._sensitive_keys:
                sanitized[str(key)] = "[REDACTED]"
            else:
                sanitized[str(key)] = _sanitize(inner_value)
        return sanitized
    if isinstance(value, list):
        return [_sanitize(item) for item in value]
    return value
