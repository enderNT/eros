from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Protocol

from app.dspy.modules import (
    AppointmentExtractionModule,
    ConversationReplyModule,
    RagReplyModule,
    StateRouterModule,
    StateSummaryModule,
)
from app.models.schemas import RoutingPacket, StateRoutingDecision
from app.settings import Settings

try:
    import dspy
except ImportError:  # pragma: no cover - exercised through fallback
    dspy = None  # type: ignore[assignment]


class DSPyExecutor(Protocol):
    def predict_state_router(self, payload: dict[str, Any]) -> dict[str, Any]:
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
        self._conversation_reply = ConversationReplyModule()
        self._rag_reply = RagReplyModule()
        self._state_summary = StateSummaryModule()

    def predict_state_router(self, payload: dict[str, Any]) -> dict[str, Any]:
        prediction = self._state_router.forward(**payload)
        return _prediction_to_dict(prediction)


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


def build_dspy_runtime(settings: Settings, executor: DSPyExecutor | None = None) -> DSPyRuntime:
    return DSPyRuntime(settings=settings, executor=executor)


def _serialize_router_payload(routing_packet: RoutingPacket, guard_hint: dict[str, Any]) -> dict[str, Any]:
    return {
        "user_message": routing_packet.user_message,
        "conversation_summary": routing_packet.conversation_summary,
        "active_goal": routing_packet.active_goal,
        "stage": routing_packet.stage,
        "pending_action": routing_packet.pending_action,
        "pending_question": routing_packet.pending_question,
        "appointment_slots": json.dumps(routing_packet.appointment_slots, ensure_ascii=False, sort_keys=True),
        "last_tool_result": routing_packet.last_tool_result,
        "last_user_message": routing_packet.last_user_message,
        "last_assistant_message": routing_packet.last_assistant_message,
        "memories": json.dumps(routing_packet.memories, ensure_ascii=False),
        "guard_hint": json.dumps(guard_hint, ensure_ascii=False, sort_keys=True),
    }


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
