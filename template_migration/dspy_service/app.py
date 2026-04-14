from __future__ import annotations

import logging
import os
from typing import Any

from fastapi import FastAPI

from signatures import (
    AppointmentReplySignature,
    ConversationReplySignature,
    RagReplySignature,
    StateRouterSignature,
)

try:
    import dspy  # type: ignore
except Exception:  # pragma: no cover - optional dependency bootstrap
    dspy = None


logging.basicConfig(level=os.getenv("DSPY_LOG_LEVEL", "INFO").upper())
LOGGER = logging.getLogger("eros-dspy-service")

app = FastAPI(title="eros-dspy-runtime", version="0.1.0")


def configure_dspy() -> str:
    if not dspy:
        return "heuristic"

    api_base = os.getenv("DSPY_API_BASE", "").strip()
    api_key = os.getenv("DSPY_API_KEY", "").strip()
    model = os.getenv("DSPY_MODEL", "gpt-4o-mini").strip()
    if not api_base or not api_key:
        return "heuristic"

    try:
        qualified_model = model if "/" in model else f"openai/{model}"
        dspy.configure(lm=dspy.LM(model=qualified_model, api_base=api_base, api_key=api_key))
        return "dspy"
    except Exception as error:  # pragma: no cover - external runtime
        LOGGER.exception("Failed to configure DSPy: %s", error)
        return "heuristic"


BACKEND = configure_dspy()


def maybe_predict(signature: type[Any], payload: dict[str, Any], fields: list[str]) -> dict[str, Any] | None:
    if not dspy or BACKEND != "dspy":
        return None
    try:
        prediction = dspy.Predict(signature)(**payload)
        return {field: getattr(prediction, field, None) for field in fields}
    except Exception as error:  # pragma: no cover - external runtime
        LOGGER.warning("DSPy prediction failed: %s", error)
        return None


def heuristic_route(payload: dict[str, Any]) -> dict[str, Any]:
    user_message = str(payload.get("user_message", "")).lower()
    if any(keyword in user_message for keyword in ("cita", "agendar", "agenda", "calendly", "reservar")):
        return {
            "next_node": "appointment",
            "intent": "appointment",
            "confidence": 0.82,
            "needs_retrieval": False,
            "state_update": {
                "active_goal": "appointment",
                "stage": "collecting_slots",
                "pending_action": "collecting_slots",
            },
            "reason": "heuristic-appointment",
        }
    if any(keyword in user_message for keyword in ("horario", "precio", "servicio", "doctor", "terapia", "valoracion")):
        return {
            "next_node": "rag",
            "intent": "rag",
            "confidence": 0.78,
            "needs_retrieval": True,
            "state_update": {
                "active_goal": "information",
                "stage": "lookup",
            },
            "reason": "heuristic-rag",
        }
    return {
        "next_node": "conversation",
        "intent": "conversation",
        "confidence": 0.72,
        "needs_retrieval": False,
        "state_update": {
            "active_goal": payload.get("active_goal") or "conversation",
            "stage": payload.get("stage") or "open",
        },
        "reason": "heuristic-conversation",
    }


def heuristic_reply(prefix: str, payload: dict[str, Any]) -> dict[str, Any]:
    user_message = str(payload.get("user_message", "")).strip()
    return {"response_text": f"{prefix} {user_message}".strip(), "reply_mode": "fallback"}


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "backend": BACKEND,
        "dspy_available": bool(dspy),
    }


@app.post("/predict/state-router")
def predict_state_router(payload: dict[str, Any]) -> dict[str, Any]:
    prediction = maybe_predict(
        StateRouterSignature,
        {
            "user_message": payload.get("user_message", ""),
            "conversation_summary": payload.get("conversation_summary", ""),
            "active_goal": payload.get("active_goal", ""),
            "stage": payload.get("stage", ""),
            "pending_action": payload.get("pending_action", ""),
            "pending_question": payload.get("pending_question", ""),
            "appointment_slots": payload.get("appointment_slots", {}),
            "last_tool_result": payload.get("last_tool_result", ""),
            "last_user_message": payload.get("last_user_message", ""),
            "last_assistant_message": payload.get("last_assistant_message", ""),
            "memories": payload.get("memories", []),
            "guard_hint": payload.get("guard_hint", {}),
        },
        ["next_node", "intent", "confidence", "needs_retrieval", "state_update", "reason"],
    )
    return prediction or heuristic_route(payload)


@app.post("/predict/conversation-reply")
def predict_conversation_reply(payload: dict[str, Any]) -> dict[str, Any]:
    prediction = maybe_predict(
        ConversationReplySignature,
        {
            "user_message": payload.get("user_message", ""),
            "summary": payload.get("summary", ""),
            "active_goal": payload.get("active_goal", ""),
            "stage": payload.get("stage", ""),
            "pending_question": payload.get("pending_question", ""),
            "last_assistant_message": payload.get("last_assistant_message", ""),
            "recent_turns": payload.get("recent_turns", []),
            "memories": payload.get("memories", []),
        },
        ["response_text"],
    )
    return {"response_text": str(prediction.get("response_text", "")).strip(), "reply_mode": "llm"} if prediction else heuristic_reply(
        "Seguimos con tu consulta en Clinica Eros Neuronal.", payload
    )


@app.post("/predict/rag-reply")
def predict_rag_reply(payload: dict[str, Any]) -> dict[str, Any]:
    prediction = maybe_predict(
        RagReplySignature,
        {
            "user_message": payload.get("user_message", ""),
            "summary": payload.get("summary", ""),
            "active_goal": payload.get("active_goal", ""),
            "stage": payload.get("stage", ""),
            "pending_question": payload.get("pending_question", ""),
            "last_assistant_message": payload.get("last_assistant_message", ""),
            "recent_turns": payload.get("recent_turns", []),
            "memories": payload.get("memories", []),
            "retrieved_context": payload.get("retrieved_context", ""),
        },
        ["response_text"],
    )
    return {"response_text": str(prediction.get("response_text", "")).strip(), "reply_mode": "llm"} if prediction else heuristic_reply(
        "Comparto la informacion recuperada para tu consulta.", payload
    )


@app.post("/predict/appointment-reply")
def predict_appointment_reply(payload: dict[str, Any]) -> dict[str, Any]:
    prediction = maybe_predict(
        AppointmentReplySignature,
        {
            "user_message": payload.get("user_message", ""),
            "contact_name": payload.get("contact_name", ""),
            "summary": payload.get("summary", ""),
            "active_goal": payload.get("active_goal", ""),
            "stage": payload.get("stage", ""),
            "pending_question": payload.get("pending_question", ""),
            "last_assistant_message": payload.get("last_assistant_message", ""),
            "recent_turns": payload.get("recent_turns", []),
            "memories": payload.get("memories", []),
            "appointment_state": payload.get("appointment_state", {}),
            "booking_url": payload.get("booking_url", ""),
        },
        ["response_text"],
    )
    return {"response_text": str(prediction.get("response_text", "")).strip(), "reply_mode": "llm"} if prediction else heuristic_reply(
        f"Puedes continuar tu solicitud de cita aqui: {payload.get('booking_url', '')}", payload
    )
