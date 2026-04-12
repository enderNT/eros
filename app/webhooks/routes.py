from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status

from app.models.schemas import ChatwootWebhook
from app.observability.flow_logger import new_flow_id, step, substep
from app.services.agent import ClinicAgentService

logger = logging.getLogger(__name__)


def build_webhook_router(agent_service: ClinicAgentService | None = None) -> APIRouter:
    router = APIRouter(prefix="/webhooks", tags=["webhooks"])

    @router.post("/chatwoot", status_code=status.HTTP_202_ACCEPTED)
    async def chatwoot_webhook(payload: ChatwootWebhook, request: Request) -> dict[str, str]:
        resolved_agent_service = agent_service or getattr(request.app.state, "agent_service", None)
        if resolved_agent_service is None:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Agent service is not initialized.",
            )
        flow_id = new_flow_id()
        step(
            "1. webhook_received",
            "OK",
            f"flow={flow_id} conv={payload.conversation_id} contact={payload.contact_id}",
        )
        if not payload.is_incoming_message_event:
            substep(
                "webhook_payload_validated",
                "OK",
                f"ignorado event={payload.event or 'n/a'} message_type={payload.message_type or 'n/a'}",
            )
            return {"status": "ignored", "conversation_id": payload.conversation_id}
        substep("webhook_payload_validated", "RUN", "validando contenido util")
        if not payload.latest_message:
            substep("webhook_payload_validated", "ERROR", "sin contenido procesable")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Webhook sin contenido util para procesar.",
            )
        substep("webhook_payload_validated", "OK", "contenido detectado")
        substep("webhook_background_dispatch", "RUN", "enviando al flujo asyncrono")
        runtime_monitor = getattr(request.app.state, "background_task_monitor", None)
        asyncio.create_task(_safe_process(resolved_agent_service, payload, flow_id, runtime_monitor))
        substep("webhook_background_dispatch", "OK", "task creada")
        return {"status": "accepted", "conversation_id": payload.conversation_id}

    return router


async def _safe_process(
    agent_service: ClinicAgentService,
    payload: ChatwootWebhook,
    flow_id: str,
    runtime_monitor: Any | None = None,
) -> None:
    try:
        await agent_service.process_webhook(payload, flow_id=flow_id)
        if runtime_monitor is not None:
            runtime_monitor.record_success(payload.conversation_id, flow_id)
    except Exception as exc:  # pragma: no cover - logging defensivo
        if runtime_monitor is not None:
            runtime_monitor.record_failure(payload.conversation_id, flow_id, exc)
        logger.exception(
            "Webhook was accepted but background processing failed for conversation=%s flow=%s: %s",
            payload.conversation_id,
            flow_id,
            exc,
        )
