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
        if stage == "project" and section == "metadata" and isinstance(sanitized, dict):
            return {key: value for key, value in sanitized.items() if key not in {"response_text", "response_preview"}}
        return sanitized


class RoutingDecisionProjector:
    name = "routing_decision"
    version = "v2"

    def project(self, trace_record) -> list[ProjectedExample]:
        if trace_record.outcome != "success":
            return []
        routing_fragment = next((fragment for fragment in trace_record.fragments if fragment.kind == "routing_decision"), None)
        if routing_fragment is None:
            return []
        routing_input = next((fragment for fragment in trace_record.fragments if fragment.kind == "routing_input"), None)
        memory_fragment = next((fragment for fragment in trace_record.fragments if fragment.kind == "memory_lookup"), None)
        routing_packet = dict(routing_input.payload.get("routing_packet", {})) if routing_input else {}
        input_payload = routing_packet or {
            "user_message": trace_record.input_payload.get("message", ""),
            "conversation_summary": "",
            "active_goal": "",
            "stage": "",
            "pending_action": "",
            "pending_question": "",
            "appointment_slots": {},
            "last_tool_result": "",
            "last_user_message": trace_record.input_payload.get("message", ""),
            "last_assistant_message": "",
            "memories": [],
        }
        if memory_fragment is not None and not input_payload.get("memories"):
            input_payload["memories"] = memory_fragment.payload.get("recalled_memories", [])
        return [
            ProjectedExample(
                trace_id=trace_record.envelope.trace_id,
                task_name="state_router",
                projector_version=self.version,
                input_payload=input_payload,
                target_payload={
                    "next_node": routing_fragment.payload.get("next_node"),
                    "intent": routing_fragment.payload.get("intent"),
                    "confidence": routing_fragment.payload.get("confidence"),
                    "needs_retrieval": routing_fragment.payload.get("needs_retrieval"),
                    "state_update": routing_fragment.payload.get("state_update", {}),
                    "reason": routing_fragment.payload.get("reason", ""),
                },
                metadata_payload={
                    "outcome": trace_record.outcome,
                    "conversation_id": trace_record.input_payload.get("conversation_id"),
                    "guard_hint": routing_input.payload.get("guard_hint") if routing_input else None,
                },
                eligibility_reason="routing-fragment-present",
            )
        ]


class AppointmentExtractionProjector:
    name = "appointment_extraction"
    version = "v1"

    def project(self, trace_record) -> list[ProjectedExample]:
        if trace_record.outcome != "success":
            return []
        fragment = next((item for item in trace_record.fragments if item.kind == "appointment_extraction"), None)
        if fragment is None:
            return []
        return [
            ProjectedExample(
                trace_id=trace_record.envelope.trace_id,
                task_name="appointment_extraction",
                projector_version=self.version,
                input_payload={
                    "user_message": fragment.payload.get("user_message", trace_record.input_payload.get("message", "")),
                    "memories": fragment.payload.get("memories", []),
                    "clinic_context": fragment.payload.get("clinic_context_preview", ""),
                    "contact_name": trace_record.input_payload.get("contact_name", ""),
                    "current_slots": fragment.payload.get("current_slots", {}),
                    "pending_question": fragment.payload.get("pending_question", ""),
                    "reply_context": fragment.payload.get("reply_context", {}),
                },
                target_payload=dict(fragment.payload.get("payload", {})),
                metadata_payload={
                    "missing_fields": fragment.payload.get("missing_fields", []),
                    "response_text": fragment.payload.get("response_text", ""),
                },
                eligibility_reason="appointment-fragment-present",
            )
        ]


class ConversationReplyProjector:
    name = "conversation_reply"
    version = "v2"

    def project(self, trace_record) -> list[ProjectedExample]:
        if trace_record.outcome != "success":
            return []
        input_fragment = next((item for item in trace_record.fragments if item.kind == "conversation_reply_input"), None)
        output_fragment = next((item for item in trace_record.fragments if item.kind == "conversation_reply_output"), None)
        if input_fragment is None or output_fragment is None:
            return []
        return [
            ProjectedExample(
                trace_id=trace_record.envelope.trace_id,
                task_name="conversation_reply",
                projector_version=self.version,
                input_payload=dict(input_fragment.payload),
                target_payload={"response_text": output_fragment.payload.get("response_text", "")},
                metadata_payload={
                    "reply_mode": output_fragment.payload.get("reply_mode", "llm"),
                    "node": "conversation",
                },
                eligibility_reason="conversation-reply-present",
            )
        ]


class RagReplyProjector:
    name = "rag_reply"
    version = "v2"

    def project(self, trace_record) -> list[ProjectedExample]:
        if trace_record.outcome != "success":
            return []
        input_fragment = next((item for item in trace_record.fragments if item.kind == "rag_reply_input"), None)
        output_fragment = next((item for item in trace_record.fragments if item.kind == "rag_reply_output"), None)
        if input_fragment is None or output_fragment is None:
            return []
        return [
            ProjectedExample(
                trace_id=trace_record.envelope.trace_id,
                task_name="rag_reply",
                projector_version=self.version,
                input_payload=dict(input_fragment.payload),
                target_payload={"response_text": output_fragment.payload.get("response_text", "")},
                metadata_payload={"reply_mode": output_fragment.payload.get("reply_mode", "llm"), "node": "rag"},
                eligibility_reason="rag-reply-present",
            )
        ]


class AppointmentReplyProjector:
    name = "appointment_reply"
    version = "v1"

    def project(self, trace_record) -> list[ProjectedExample]:
        if trace_record.outcome != "success":
            return []
        input_fragment = next((item for item in trace_record.fragments if item.kind == "appointment_reply_input"), None)
        output_fragment = next((item for item in trace_record.fragments if item.kind == "appointment_reply_output"), None)
        if input_fragment is None or output_fragment is None:
            return []
        return [
            ProjectedExample(
                trace_id=trace_record.envelope.trace_id,
                task_name="appointment_reply",
                projector_version=self.version,
                input_payload=dict(input_fragment.payload),
                target_payload={"response_text": output_fragment.payload.get("response_text", "")},
                metadata_payload={
                    "reply_mode": output_fragment.payload.get("reply_mode", "llm"),
                    "node": "appointment",
                },
                eligibility_reason="appointment-reply-present",
            )
        ]


class StateSummaryProjector:
    name = "state_summary"
    version = "v1"

    def project(self, trace_record) -> list[ProjectedExample]:
        if trace_record.outcome != "success":
            return []
        fragment = next((item for item in trace_record.fragments if item.kind == "state_summary"), None)
        if fragment is None:
            return []
        return [
            ProjectedExample(
                trace_id=trace_record.envelope.trace_id,
                task_name="state_summary",
                projector_version=self.version,
                input_payload={
                    "current_summary": fragment.payload.get("current_summary", ""),
                    "user_message": fragment.payload.get("user_message", ""),
                    "assistant_message": fragment.payload.get("assistant_message", ""),
                    "active_goal": fragment.payload.get("active_goal", ""),
                    "stage": fragment.payload.get("stage", ""),
                },
                target_payload={"updated_summary": fragment.payload.get("updated_summary", "")},
                metadata_payload={"outcome": trace_record.outcome},
                eligibility_reason="summary-fragment-present",
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
    projectors: list[TraceProjector] = (
        [
            ConversationReplyProjector(),
            RagReplyProjector(),
            AppointmentReplyProjector(),
        ]
        if settings.trace_projectors_enabled
        else []
    )

    if settings.trace_backend == "postgres":
        if not settings.trace_postgres_dsn:
            raise RuntimeError("`trace_postgres_dsn` is required when `trace_backend=postgres`.")
        repository = PostgresTraceRepository(settings.trace_postgres_dsn, schema=settings.trace_postgres_schema)
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
