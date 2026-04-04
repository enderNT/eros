from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Protocol, TypedDict

from app.dspy.modules import (
    AppointmentExtractionModule,
    AppointmentReplyModule,
    ConversationReplyModule,
    RagReplyModule,
    StateRouterModule,
    StateSummaryModule,
)
from app.models.schemas import RoutingPacket, StateRoutingDecision
from app.services.llm import ClinicLLMService, GeneratedReply
from app.settings import Settings

try:
    import dspy
except ImportError:  # pragma: no cover - exercised through fallback
    dspy = None  # type: ignore[assignment]


logger = logging.getLogger(__name__)


class ConversationReplyPayload(TypedDict):
    user_message: str
    summary: str
    active_goal: str
    stage: str
    pending_question: str
    last_assistant_message: str
    recent_turns: list[dict[str, Any]]
    memories: list[str]


class RagReplyPayload(ConversationReplyPayload):
    retrieved_context: str


class AppointmentReplyPayload(ConversationReplyPayload):
    contact_name: str
    appointment_state: dict[str, Any]
    booking_url: str


class DSPyExecutor(Protocol):
    def predict_state_router(self, payload: dict[str, Any]) -> dict[str, Any]:
        ...

    def predict_conversation_reply(self, payload: dict[str, Any]) -> dict[str, Any]:
        ...

    def predict_rag_reply(self, payload: dict[str, Any]) -> dict[str, Any]:
        ...

    def predict_appointment_reply(self, payload: dict[str, Any]) -> dict[str, Any]:
        ...


class NativeDSPyExecutor:
    def __init__(self, settings: Settings) -> None:
        if dspy is None:
            raise RuntimeError("DSPy is not installed. Install project dependencies to enable DSPy runtime.")
        model_name = settings.resolved_dspy_model
        qualified_model = model_name if "/" in model_name else f"openai/{model_name}"
        lm_kwargs: dict[str, Any] = {}
        if settings.resolved_dspy_api_key:
            lm_kwargs["api_key"] = settings.resolved_dspy_api_key
        if settings.resolved_dspy_base_url:
            lm_kwargs["api_base"] = settings.resolved_dspy_base_url.rstrip("/")
        if settings.resolved_llm_temperature is not None:
            lm_kwargs["temperature"] = settings.resolved_llm_temperature
        dspy.configure(lm=dspy.LM(model=qualified_model, **lm_kwargs))
        self._state_router = StateRouterModule()
        self._appointment_extraction = AppointmentExtractionModule()
        self._state_summary = StateSummaryModule()
        self._modules = {
            "conversation_reply": self._load_module(
                settings.resolve_dspy_artifact_path("conversation_reply"),
                ConversationReplyModule,
            ),
            "rag_reply": self._load_module(
                settings.resolve_dspy_artifact_path("rag_reply"),
                RagReplyModule,
            ),
            "appointment_reply": self._load_module(
                settings.resolve_dspy_artifact_path("appointment_reply"),
                AppointmentReplyModule,
            ),
        }

    def predict_state_router(self, payload: dict[str, Any]) -> dict[str, Any]:
        prediction = self._state_router.forward(**payload)
        return _prediction_to_dict(prediction)

    def predict_conversation_reply(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._predict_task("conversation_reply", payload)

    def predict_rag_reply(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._predict_task("rag_reply", payload)

    def predict_appointment_reply(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._predict_task("appointment_reply", payload)

    def _predict_task(self, task_name: str, payload: dict[str, Any]) -> dict[str, Any]:
        module = self._modules.get(task_name)
        if module is None:
            raise FileNotFoundError(f"No DSPy artifact available for task {task_name!r}.")
        prediction = module.forward(**payload)
        return _prediction_to_dict(prediction)

    def _load_module(self, artifact_path: Path, module_factory: type[Any]) -> Any | None:
        if not artifact_path.exists():
            return None
        module = module_factory()
        load = getattr(module, "load", None)
        if not callable(load):
            raise RuntimeError(f"DSPy module {module_factory.__name__} does not support artifact loading.")
        load(str(artifact_path))
        return module


@dataclass(slots=True)
class DSPyRuntime:
    settings: Settings
    executor: DSPyExecutor | None = None

    @property
    def enabled(self) -> bool:
        return self.settings.dspy_enabled

    @property
    def router_enabled(self) -> bool:
        return self.enabled and self.settings.dspy_router_enabled

    @property
    def reply_enabled(self) -> bool:
        return self.enabled

    async def classify_state_route(
        self,
        routing_packet: RoutingPacket,
        *,
        guard_hint: dict[str, Any] | None = None,
    ) -> StateRoutingDecision:
        if not self.router_enabled:
            raise RuntimeError("DSPy router is disabled.")
        executor = self.executor or NativeDSPyExecutor(self.settings)
        raw = executor.predict_state_router(_serialize_router_payload(routing_packet, guard_hint or {}))
        return _coerce_state_routing_decision(raw)

    async def generate_conversation_reply(
        self,
        payload: ConversationReplyPayload,
        llm_service: ClinicLLMService,
        *,
        context: Any | None = None,
    ) -> GeneratedReply:
        return await self._generate_reply(
            task_name="conversation_reply",
            serialized_payload=_serialize_conversation_reply_payload(payload),
            predictor=lambda executor, values: executor.predict_conversation_reply(values),
            fallback=lambda: llm_service.generate_conversation_reply(
                user_message=payload["user_message"],
                memories=payload["memories"],
                context=context,
            ),
        )

    async def build_conversation_reply(
        self,
        payload: ConversationReplyPayload,
        llm_service: ClinicLLMService,
        *,
        context: Any | None = None,
    ) -> str:
        return (await self.generate_conversation_reply(payload, llm_service, context=context)).response_text

    async def generate_rag_reply(
        self,
        payload: RagReplyPayload,
        llm_service: ClinicLLMService,
        *,
        context: Any | None = None,
    ) -> GeneratedReply:
        return await self._generate_reply(
            task_name="rag_reply",
            serialized_payload=_serialize_rag_reply_payload(payload),
            predictor=lambda executor, values: executor.predict_rag_reply(values),
            fallback=lambda: llm_service.generate_rag_reply(
                user_message=payload["user_message"],
                memories=payload["memories"],
                clinic_context=payload["retrieved_context"],
                context=context,
            ),
        )

    async def build_rag_reply(
        self,
        payload: RagReplyPayload,
        llm_service: ClinicLLMService,
        *,
        context: Any | None = None,
    ) -> str:
        return (await self.generate_rag_reply(payload, llm_service, context=context)).response_text

    async def generate_appointment_reply(
        self,
        payload: AppointmentReplyPayload,
        llm_service: ClinicLLMService,
        *,
        appointment: Any,
        context: Any | None = None,
    ) -> GeneratedReply:
        return await self._generate_reply(
            task_name="appointment_reply",
            serialized_payload=_serialize_appointment_reply_payload(payload),
            predictor=lambda executor, values: executor.predict_appointment_reply(values),
            fallback=lambda: llm_service.generate_appointment_reply(
                appointment=appointment,
                user_message=payload["user_message"],
                memories=payload["memories"],
                contact_name=payload["contact_name"],
                context=context,
            ),
        )

    async def build_appointment_reply(
        self,
        payload: AppointmentReplyPayload,
        llm_service: ClinicLLMService,
        *,
        appointment: Any,
        context: Any | None = None,
    ) -> str:
        return (
            await self.generate_appointment_reply(payload, llm_service, appointment=appointment, context=context)
        ).response_text

    async def _generate_reply(
        self,
        *,
        task_name: str,
        serialized_payload: dict[str, Any],
        predictor: Callable[[DSPyExecutor, dict[str, Any]], dict[str, Any]],
        fallback: Callable[[], Awaitable[GeneratedReply]],
    ) -> GeneratedReply:
        if not self.reply_enabled:
            return await fallback()
        executor = self.executor or NativeDSPyExecutor(self.settings)
        try:
            response = predictor(executor, serialized_payload)
            response_text = _coerce_text(response.get("response_text", ""))
            if response_text:
                return GeneratedReply(response_text=response_text, reply_mode="llm")
        except Exception as exc:
            logger.warning("DSPy %s failed, falling back to LLM service: %s", task_name, exc)
        return await fallback()


def build_dspy_runtime(settings: Settings, executor: DSPyExecutor | None = None) -> DSPyRuntime:
    return DSPyRuntime(settings=settings, executor=executor)


def _serialize_router_payload(routing_packet: RoutingPacket, guard_hint: dict[str, Any]) -> dict[str, Any]:
    return {
        "user_message": _coerce_text(routing_packet.user_message),
        "conversation_summary": _coerce_text(routing_packet.conversation_summary),
        "active_goal": _coerce_text(routing_packet.active_goal),
        "stage": _coerce_text(routing_packet.stage),
        "pending_action": _coerce_text(routing_packet.pending_action),
        "pending_question": _coerce_text(routing_packet.pending_question),
        "appointment_slots": _stable_json(routing_packet.appointment_slots),
        "last_tool_result": _coerce_text(routing_packet.last_tool_result),
        "last_user_message": _coerce_text(routing_packet.last_user_message),
        "last_assistant_message": _coerce_text(routing_packet.last_assistant_message),
        "memories": _stable_json(routing_packet.memories),
        "guard_hint": _stable_json(guard_hint),
    }


def _serialize_conversation_reply_payload(payload: ConversationReplyPayload) -> dict[str, Any]:
    return {
        "user_message": _coerce_text(payload.get("user_message")),
        "summary": _coerce_text(payload.get("summary")),
        "active_goal": _coerce_text(payload.get("active_goal")),
        "stage": _coerce_text(payload.get("stage")),
        "pending_question": _coerce_text(payload.get("pending_question")),
        "last_assistant_message": _coerce_text(payload.get("last_assistant_message")),
        "recent_turns": _stable_json(payload.get("recent_turns", [])),
        "memories": _stable_json(payload.get("memories", [])),
    }


def _serialize_rag_reply_payload(payload: RagReplyPayload) -> dict[str, Any]:
    serialized = _serialize_conversation_reply_payload(payload)
    serialized["retrieved_context"] = _coerce_text(payload.get("retrieved_context"))
    return serialized


def _serialize_appointment_reply_payload(payload: AppointmentReplyPayload) -> dict[str, Any]:
    serialized = _serialize_conversation_reply_payload(payload)
    serialized["contact_name"] = _coerce_text(payload.get("contact_name"))
    serialized["appointment_state"] = _stable_json(payload.get("appointment_state", {}))
    serialized["booking_url"] = _coerce_text(payload.get("booking_url"))
    return serialized


def _prediction_to_dict(prediction: Any) -> dict[str, Any]:
    if isinstance(prediction, dict):
        return dict(prediction)
    if hasattr(prediction, "toDict"):
        return dict(prediction.toDict())
    if hasattr(prediction, "items"):
        return dict(prediction.items())
    return {
        "next_node": getattr(prediction, "next_node", "conversation"),
        "intent": getattr(prediction, "intent", "conversation"),
        "confidence": getattr(prediction, "confidence", 0.0),
        "needs_retrieval": getattr(prediction, "needs_retrieval", False),
        "state_update": getattr(prediction, "state_update", {}),
        "reason": getattr(prediction, "reason", ""),
        "response_text": getattr(prediction, "response_text", ""),
    }


def _coerce_state_routing_decision(payload: dict[str, Any]) -> StateRoutingDecision:
    normalized = dict(payload)
    normalized["confidence"] = _coerce_float(normalized.get("confidence", 0.0))
    normalized["needs_retrieval"] = _coerce_bool(normalized.get("needs_retrieval", False))
    normalized["state_update"] = _coerce_state_update(normalized.get("state_update"))
    return StateRoutingDecision.model_validate(normalized)


def _coerce_state_update(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if value is None:
        return {}
    if isinstance(value, str):
        compact = value.strip()
        if not compact:
            return {}
        try:
            parsed = json.loads(compact)
        except json.JSONDecodeError:
            return {"notes": compact}
        return parsed if isinstance(parsed, dict) else {"value": parsed}
    return {"value": value}


def _coerce_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _coerce_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "si", "sí"}
    return bool(value)


def _coerce_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)
