from __future__ import annotations

import logging
from typing import Any

from app.graph.workflow import ClinicWorkflow
from app.models.schemas import ChatwootWebhook
from app.observability.flow_logger import bind_flow, clear_flow, end_flow, mark_error, start_flow, step, substep
from app.services.chatwoot import ChatwootClient
from app.services.tracing import TraceRuntime
from app.settings import Settings
from app.tracing import bind_trace_context, reset_trace_context

logger = logging.getLogger(__name__)


class ClinicAgentService:
    def __init__(
        self,
        workflow: ClinicWorkflow,
        chatwoot_client: ChatwootClient,
        trace_runtime: TraceRuntime,
        settings: Settings,
    ) -> None:
        self._workflow = workflow
        self._chatwoot_client = chatwoot_client
        self._trace_runtime = trace_runtime
        self._settings = settings

    async def process_webhook(self, payload: ChatwootWebhook, flow_id: str | None = None) -> dict[str, Any]:
        resolved_flow_id = flow_id or payload.conversation_id
        bind_flow(resolved_flow_id, payload.conversation_id)
        trace_context = self._trace_runtime.start_turn(payload, flow_id=resolved_flow_id, settings=self._settings)
        trace_context.capture_input(payload)
        trace_token = bind_trace_context(trace_context)
        start_flow(payload.latest_message)
        try:
            step("2. state_routing_and_graph", "RUN", "ejecutando LangGraph")
            result = await self._workflow.run(payload)
            step(
                "2. state_routing_and_graph",
                "OK",
                f"intent={result.get('intent')} confidence={result.get('confidence', 0):.2f}",
            )
            trace_context.capture_fragment(
                "workflow_result",
                {
                    "next_node": result.get("next_node"),
                    "intent": result.get("intent"),
                    "confidence": result.get("confidence"),
                    "handoff_required": result.get("handoff_required"),
                },
                label="workflow",
            )

            response_text = result.get("response_text")
            if response_text:
                step("4. outbound_response", "RUN", "enviando respuesta a Chatwoot")
                try:
                    await self._chatwoot_client.send_message(
                        payload.conversation_id,
                        response_text,
                        account_id=payload.account_id,
                    )
                    step("4. outbound_response", "OK", "respuesta enviada o logueada")
                    trace_context.capture_fragment(
                        "outbound_response",
                        {"status": "sent", "conversation_id": payload.conversation_id},
                        label="chatwoot",
                    )
                except Exception as exc:  # pragma: no cover - depende de Chatwoot
                    mark_error("4. outbound_response", exc)
                    trace_context.capture_fragment(
                        "outbound_response",
                        {"status": "error", "error_type": type(exc).__name__, "message": str(exc)},
                        label="chatwoot",
                    )
                    logger.exception("Failed to send Chatwoot response for %s: %s", payload.conversation_id, exc)
            else:
                substep("4. outbound_response", "WARN", "sin response_text para enviar")
                trace_context.capture_fragment(
                    "outbound_response",
                    {"status": "skipped", "reason": "missing-response-text"},
                    label="chatwoot",
                )

            trace_context.capture_output(result)
            record = trace_context.finalize(
                "success",
                metrics_payload={
                    "response_chars": len(response_text or ""),
                    "branch": result.get("next_node"),
                },
                tags={"branch": result.get("next_node"), "intent": result.get("intent")},
            )
            await self._trace_runtime.sink.enqueue(record)
            end_flow("OK", f"branch={result.get('next_node', result.get('intent', 'unknown'))}")
            return result
        except Exception as exc:
            mark_error("flow_execution", exc)
            trace_context.capture_error(exc)
            record = trace_context.finalize(
                "error",
                metrics_payload={"response_chars": 0},
                tags={"branch": "error"},
            )
            await self._trace_runtime.sink.enqueue(record)
            end_flow("ERROR")
            raise
        finally:
            reset_trace_context(trace_token)
            clear_flow()
