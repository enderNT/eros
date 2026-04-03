from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from typing import Protocol

from app.tracing.policy import AllowAllFieldPolicy, FieldPolicy
from app.tracing.repository import TraceRepository
from app.tracing.types import ProjectedExample, TraceFragment, TraceRecord

logger = logging.getLogger(__name__)


class TraceProjector(Protocol):
    name: str
    version: str

    def project(self, trace_record: TraceRecord) -> list[ProjectedExample]:
        ...


class NoopTraceSink:
    async def enqueue(self, trace_record: TraceRecord) -> None:
        del trace_record

    async def close(self) -> None:
        return None


class AsyncBatchTraceSink:
    _STOP = object()

    def __init__(
        self,
        repository: TraceRepository,
        *,
        projectors: Sequence[TraceProjector] | None = None,
        field_policy: FieldPolicy | None = None,
        batch_size: int = 25,
        flush_interval_seconds: float = 1.0,
    ) -> None:
        self._repository = repository
        self._projectors = list(projectors or [])
        self._field_policy = field_policy or AllowAllFieldPolicy()
        self._batch_size = max(1, batch_size)
        self._flush_interval_seconds = max(0.05, flush_interval_seconds)
        self._queue: asyncio.Queue[TraceRecord | object] = asyncio.Queue()
        self._worker_task: asyncio.Task[None] | None = None
        self._closed = False

    async def start(self) -> "AsyncBatchTraceSink":
        if self._worker_task is None:
            self._worker_task = asyncio.create_task(self._run_worker())
        return self

    async def enqueue(self, trace_record: TraceRecord) -> None:
        if self._closed:
            raise RuntimeError("Trace sink is already closed.")
        if self._worker_task is None:
            await self.start()
        await self._queue.put(trace_record.model_copy(deep=True))

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._worker_task is None:
            return
        await self._queue.put(self._STOP)
        await self._worker_task

    async def _run_worker(self) -> None:
        pending: list[TraceRecord] = []
        while True:
            try:
                item = await asyncio.wait_for(self._queue.get(), timeout=self._flush_interval_seconds)
            except asyncio.TimeoutError:
                item = None

            if item is self._STOP:
                if pending:
                    await self._flush(pending)
                return

            if item is None:
                if pending:
                    await self._flush(pending)
                    pending = []
                continue

            pending.append(item)
            if len(pending) >= self._batch_size:
                await self._flush(pending)
                pending = []

    async def _flush(self, batch: Sequence[TraceRecord]) -> None:
        if not batch:
            return
        sanitized_records = [self._sanitize_record(record) for record in batch]
        examples: list[ProjectedExample] = []
        for record in sanitized_records:
            for projector in self._projectors:
                projected = projector.project(record)
                examples.extend(self._sanitize_examples(projected))
            record.projector_eligibility_summary = _build_eligibility_summary(record.envelope.trace_id, examples)
        await self._repository.save_batch(sanitized_records, examples)

    def _sanitize_record(self, record: TraceRecord) -> TraceRecord:
        sanitized = record.model_copy(deep=True)
        sanitized.input_payload = _sanitize_payload(self._field_policy, sanitized.input_payload, stage="persist", section="input")
        sanitized.output_payload = _sanitize_payload(
            self._field_policy,
            sanitized.output_payload,
            stage="persist",
            section="output",
        )
        sanitized.error_payload = _sanitize_payload(self._field_policy, sanitized.error_payload, stage="persist", section="error")
        sanitized.metrics_payload = _sanitize_payload(
            self._field_policy,
            sanitized.metrics_payload,
            stage="persist",
            section="metrics",
        )
        sanitized.tags = _sanitize_payload(self._field_policy, sanitized.tags, stage="persist", section="tags")
        sanitized.extra_payload = _sanitize_payload(self._field_policy, sanitized.extra_payload, stage="persist", section="extra")
        sanitized.fragments = [
            TraceFragment(
                kind=fragment.kind,
                order=fragment.order,
                label=fragment.label,
                payload=_sanitize_payload(self._field_policy, fragment.payload, stage="persist", section="fragment"),
                latency_ms=fragment.latency_ms,
                token_usage=_sanitize_payload(self._field_policy, fragment.token_usage, stage="persist", section="token_usage"),
                created_at=fragment.created_at,
            )
            for fragment in sanitized.fragments
        ]
        return sanitized

    def _sanitize_examples(self, examples: Sequence[ProjectedExample]) -> list[ProjectedExample]:
        sanitized_examples: list[ProjectedExample] = []
        for example in examples:
            sanitized_examples.append(
                example.model_copy(
                    update={
                        "input_payload": _sanitize_payload(
                            self._field_policy,
                            example.input_payload,
                            stage="project",
                            section="input",
                        ),
                        "target_payload": _sanitize_payload(
                            self._field_policy,
                            example.target_payload,
                            stage="project",
                            section="target",
                        ),
                        "metadata_payload": _sanitize_payload(
                            self._field_policy,
                            example.metadata_payload,
                            stage="project",
                            section="metadata",
                        ),
                    },
                    deep=True,
                )
            )
        return sanitized_examples


def _sanitize_payload(field_policy: FieldPolicy, payload: object, *, stage: str, section: str) -> dict:
    sanitized = field_policy.apply(payload, stage=stage, section=section)
    if not isinstance(sanitized, dict):
        return {"value": sanitized}
    return sanitized


def _build_eligibility_summary(trace_id: str, examples: Sequence[ProjectedExample]) -> dict[str, object]:
    trace_examples = [example for example in examples if example.trace_id == trace_id]
    return {
        "projected_count": len(trace_examples),
        "tasks": sorted({example.task_name for example in trace_examples}),
    }
