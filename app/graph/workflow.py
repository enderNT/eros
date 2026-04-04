from __future__ import annotations

import logging
from copy import deepcopy
from typing import Any, TypedDict

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph

from app.memory_runtime import ConversationMemoryRuntime, ShortTermState, TurnMemoryInput
from app.models.schemas import ChatwootWebhook
from app.observability.flow_logger import mark_error, step, substep
from app.services.clinic_config import ClinicConfigLoader
from app.services.llm import ClinicLLMService, ReplyContext
from app.services.qdrant import QdrantRetrievalService
from app.services.router import StateRoutingService
from app.settings import Settings
from app.tracing import get_trace_context

logger = logging.getLogger(__name__)


class GraphState(TypedDict, total=False):
    session_id: str
    actor_id: str
    contact_name: str
    last_user_message: str
    last_assistant_message: str
    summary: str
    active_goal: str
    stage: str
    pending_action: str
    pending_question: str
    appointment_slots: dict[str, Any]
    last_tool_result: str
    recalled_memories: list[str]
    next_node: str
    intent: str
    confidence: float
    needs_retrieval: bool
    routing_reason: str
    state_update: dict[str, Any]
    response_text: str
    appointment_payload: dict[str, Any]
    handoff_required: bool
    turn_count: int
    summary_refresh_requested: bool
    recent_turns: list[dict[str, str]]


class ClinicWorkflow:
    def __init__(
        self,
        router_service: StateRoutingService,
        llm_service: ClinicLLMService,
        memory_runtime: ConversationMemoryRuntime,
        clinic_config_loader: ClinicConfigLoader,
        qdrant_service: QdrantRetrievalService,
        settings: Settings,
        checkpointer: object | None = None,
    ) -> None:
        self._router_service = router_service
        self._llm_service = llm_service
        self._memory_runtime = memory_runtime
        self._clinic_config_loader = clinic_config_loader
        self._qdrant_service = qdrant_service
        self._settings = settings
        self._checkpointer = checkpointer or MemorySaver()
        self._graph = self._build_graph()

    def _build_graph(self):
        graph = StateGraph(GraphState)
        graph.add_node("load_context", self._load_context)
        graph.add_node("route", self._route)
        graph.add_node("conversation", self._conversation)
        graph.add_node("rag", self._rag)
        graph.add_node("appointment", self._appointment)
        graph.add_node("finalize_turn", self._finalize_turn)
        graph.add_node("store_memory", self._store_memory)

        graph.add_edge(START, "load_context")
        graph.add_edge("load_context", "route")
        graph.add_conditional_edges(
            "route",
            self._branch_after_route,
            {
                "conversation": "conversation",
                "rag": "rag",
                "appointment": "appointment",
            },
        )
        graph.add_edge("conversation", "finalize_turn")
        graph.add_edge("rag", "finalize_turn")
        graph.add_edge("appointment", "finalize_turn")
        graph.add_edge("finalize_turn", "store_memory")
        graph.add_edge("store_memory", END)
        return graph.compile(checkpointer=self._checkpointer)

    async def run(self, webhook: ChatwootWebhook) -> GraphState:
        initial_state: GraphState = {
            "session_id": webhook.conversation_id,
            "actor_id": webhook.contact_id,
            "contact_name": webhook.contact_name,
            "last_user_message": webhook.latest_message,
        }
        config = {"configurable": {"thread_id": webhook.conversation_id}}
        return await self._graph.ainvoke(initial_state, config=config)

    async def _load_context(self, state: GraphState) -> GraphState:
        try:
            step("2.1 build_context", "RUN", "cargando estado corto y memorias duraderas")
            short_term = _build_short_term_state(state)
            context = await self._memory_runtime.load_context(
                session_id=state["session_id"],
                actor_id=state["actor_id"],
                query=state.get("last_user_message") or state.get("summary") or "contexto del usuario",
                short_term=short_term,
            )
            substep("memory_lookup", "OK", f"memories={len(context.recalled_memories)}")
            _capture_trace_fragment(
                "memory_lookup",
                {
                    "recalled_memories": self._router_service.summarize_memories(context.recalled_memories),
                    "turn_count": context.turn_count,
                },
                label="memory-runtime",
            )
            step("2.1 build_context", "OK")
            return {
                "turn_count": context.turn_count,
                "recalled_memories": self._router_service.summarize_memories(context.recalled_memories),
            }
        except Exception as exc:
            mark_error("2.1 build_context", exc)
            raise

    async def _route(self, state: GraphState) -> GraphState:
        try:
            step("2.2 state_router", "RUN", "clasificando con estado compacto")
            decision = await self._router_service.route_state(
                user_message=state["last_user_message"],
                conversation_summary=state.get("summary", ""),
                active_goal=state.get("active_goal", ""),
                stage=state.get("stage", ""),
                pending_action=state.get("pending_action", ""),
                pending_question=state.get("pending_question", ""),
                appointment_slots=state.get("appointment_slots", {}),
                last_tool_result=state.get("last_tool_result", ""),
                last_user_message=state.get("last_user_message", ""),
                last_assistant_message=state.get("last_assistant_message", ""),
                memories=state.get("recalled_memories", []),
            )
            merged_state = self._apply_state_update(state, decision.state_update)
            merged_state.update(
                {
                    "next_node": decision.next_node,
                    "intent": decision.intent,
                    "confidence": decision.confidence,
                    "needs_retrieval": decision.needs_retrieval,
                    "routing_reason": decision.reason,
                    "state_update": decision.state_update,
                    "summary_refresh_requested": merged_state.get("summary_refresh_requested", False)
                    or merged_state.get("active_goal") != state.get("active_goal"),
                }
            )
            step(
                "2.2 state_router",
                "OK",
                f"next={decision.next_node} intent={decision.intent} confidence={decision.confidence:.2f}",
            )
            _capture_trace_fragment(
                "routing_decision",
                {
                    "next_node": decision.next_node,
                    "intent": decision.intent,
                    "confidence": decision.confidence,
                    "needs_retrieval": decision.needs_retrieval,
                    "reason": decision.reason,
                    "state_update": decision.state_update,
                },
                label="state-router",
            )
            return merged_state
        except Exception as exc:
            mark_error("2.2 state_router", exc)
            raise

    def _branch_after_route(self, state: GraphState) -> str:
        branch = state.get("next_node", "conversation")
        step("3. branch_selection", "OK", f"selected={branch}")
        if branch == "conversation":
            substep("3.a conversation", "OK", "usando nodo conversacional")
        elif branch == "rag":
            substep("3.b rag", "OK", "usando nodo RAG")
        elif branch == "appointment":
            substep("3.c appointment", "OK", "usando nodo de agendado")
        else:
            substep("3.x unknown_branch", "WARN", f"branch={branch}; fallback a conversation")
            return "conversation"
        return branch

    async def _conversation(self, state: GraphState) -> GraphState:
        try:
            step("3.a.1 conversation_node", "RUN", "generando respuesta")
            reply_context = _build_reply_context(state)
            response_text = await self._llm_service.build_conversation_reply(
                user_message=state["last_user_message"],
                memories=state.get("recalled_memories", []),
                context=reply_context,
            )
            step("3.a.1 conversation_node", "OK", f"chars={len(response_text)}")
            _capture_trace_fragment(
                "llm_reply",
                {
                    "node": "conversation",
                    "response_text": response_text,
                    "memories": list(state.get("recalled_memories", [])),
                    "reply_context": _reply_context_payload(reply_context),
                },
                label="conversation",
            )
            return {
                "response_text": response_text,
                "last_assistant_message": response_text,
                "last_tool_result": "",
                "handoff_required": False,
                "appointment_payload": {},
            }
        except Exception as exc:
            mark_error("3.a.1 conversation_node", exc)
            raise

    async def _rag(self, state: GraphState) -> GraphState:
        try:
            step("3.b.1 rag_node", "RUN", "consultando contexto RAG")
            clinic_context = self._clinic_config_loader.load().to_context_text()
            reply_context = _build_reply_context(state)
            substep("clinic_config", "OK", "config estatica cargada")
            rag_context = await self._qdrant_service.build_context(
                query=state["last_user_message"] or "contexto del usuario",
                contact_id=state["actor_id"],
                clinic_context=clinic_context,
                memories=state.get("recalled_memories", []),
            )
            substep("qdrant_lookup", "OK", "contexto vectorial preparado")
            _capture_trace_fragment(
                "retrieval_context",
                {"node": "rag", "context_preview": _shorten(rag_context, 240)},
                label="qdrant",
            )
            response_text = await self._llm_service.build_rag_reply(
                user_message=state["last_user_message"],
                memories=state.get("recalled_memories", []),
                clinic_context=rag_context,
                context=reply_context,
            )
            step("3.b.1 rag_node", "OK", f"chars={len(response_text)}")
            _capture_trace_fragment(
                "llm_reply",
                {
                    "node": "rag",
                    "response_text": response_text,
                    "memories": list(state.get("recalled_memories", [])),
                    "reply_context": _reply_context_payload(reply_context),
                    "rag_context_preview": _shorten(rag_context, 240),
                },
                label="rag",
            )
            return {
                "last_tool_result": _shorten(rag_context, 240),
                "response_text": response_text,
                "last_assistant_message": response_text,
                "handoff_required": False,
                "appointment_payload": {},
            }
        except Exception as exc:
            mark_error("3.b.1 rag_node", exc)
            raise

    async def _appointment(self, state: GraphState) -> GraphState:
        try:
            step("3.c.1 appointment_node", "RUN", "extrayendo datos de cita")
            clinic_context = self._clinic_config_loader.load().to_context_text()
            reply_context = _build_reply_context(state)
            substep("clinic_config", "OK", "config estatica cargada")
            appointment, response_text = await self._llm_service.extract_appointment_intent(
                user_message=state["last_user_message"],
                memories=state.get("recalled_memories", []),
                clinic_context=clinic_context,
                contact_name=state["contact_name"],
                current_slots=state.get("appointment_slots", {}),
                pending_question=state.get("pending_question"),
                context=reply_context,
            )
            appointment_slots = _merge_slots(state.get("appointment_slots", {}), appointment.model_dump())
            missing_fields = list(appointment.missing_fields)
            pending_question = _build_pending_question(missing_fields) if missing_fields else ""
            stage = "collecting_slots" if missing_fields else "ready_for_handoff"
            pending_action = "collecting_slots" if missing_fields else ""
            if not missing_fields:
                response_text = (
                    response_text
                    + " "
                    + "Tu solicitud quedo lista para recepcion."
                ).strip()
            substep(
                "appointment_payload",
                "OK",
                f"missing_fields={len(missing_fields)} handoff={appointment.should_handoff}",
            )
            step("3.c.1 appointment_node", "OK", f"chars={len(response_text)}")
            _capture_trace_fragment(
                "appointment_extraction",
                {
                    "user_message": state["last_user_message"],
                    "memories": list(state.get("recalled_memories", [])),
                    "current_slots": deepcopy(state.get("appointment_slots", {})),
                    "pending_question": state.get("pending_question", ""),
                    "reply_context": _reply_context_payload(reply_context),
                    "clinic_context_preview": _shorten(clinic_context, 240),
                    "payload": appointment.model_dump(),
                    "response_text": response_text,
                    "missing_fields": missing_fields,
                },
                label="appointment",
            )
            return {
                "response_text": response_text,
                "last_assistant_message": response_text,
                "appointment_slots": appointment_slots,
                "pending_question": pending_question,
                "pending_action": pending_action,
                "active_goal": "appointment",
                "stage": stage,
                "last_tool_result": _shorten(
                    f"appointment missing={','.join(missing_fields) or 'none'} confidence={appointment.confidence:.2f}",
                    200,
                ),
                "handoff_required": appointment.should_handoff,
                "appointment_payload": appointment.model_dump(),
            }
        except Exception as exc:
            mark_error("3.c.1 appointment_node", exc)
            raise

    async def _finalize_turn(self, state: GraphState) -> GraphState:
        try:
            step("3.9 finalize_turn", "RUN", "limpiando estado y refrescando resumen si hace falta")
            cleaned_state = self._cleanup_state(state)
            cleaned_state["summary_refresh_requested"] = bool(
                cleaned_state.get("summary_refresh_requested") or self._needs_summary_refresh(cleaned_state)
            )
            cleaned_state["turn_count"] = int(cleaned_state.get("turn_count", 0))
            step("3.9 finalize_turn", "OK", "estado limpio")
            _capture_trace_fragment(
                "turn_finalize",
                {
                    "next_node": cleaned_state.get("next_node"),
                    "summary_refresh_requested": cleaned_state.get("summary_refresh_requested", False),
                    "turn_count": cleaned_state.get("turn_count", 0),
                },
                label="finalize-turn",
            )
            return cleaned_state
        except Exception as exc:
            mark_error("3.9 finalize_turn", exc)
            raise

    async def _store_memory(self, state: GraphState) -> GraphState:
        response_text = state.get("response_text", "")
        user_message = state.get("last_user_message", "")
        actor_id = state.get("actor_id")
        session_id = state.get("session_id")
        if not (response_text and user_message and actor_id and session_id):
            substep("3.10 store_memory", "WARN", "faltan campos para persistir")
            return {}

        turn = TurnMemoryInput(
            user_message=user_message,
            assistant_message=response_text,
            route=state.get("next_node", "conversation"),
        )
        short_term = _build_short_term_state(state)
        step("3.10 store_memory", "RUN", "persistiendo memoria de turno")
        try:
            commit_result = await self._memory_runtime.commit_turn(
                session_id=session_id,
                actor_id=actor_id,
                turn=turn,
                short_term=short_term,
                domain_state=_build_domain_state(state),
            )
        except Exception as exc:
            mark_error("3.10 store_memory", exc)
            raise

        updates: GraphState = {}
        if state.get("summary_refresh_requested"):
            updates["summary"] = _shorten(commit_result.summary, 700)
            updates["summary_refresh_requested"] = False
        updates["recent_turns"] = _append_recent_turn(
            state.get("recent_turns", []),
            user_message=user_message,
            assistant_message=response_text,
        )
        if commit_result.stored_records:
            step("3.10 store_memory", "OK", f"persistidas {len(commit_result.stored_records)} memorias utiles")
        else:
            substep("3.10 store_memory", "OK", "sin hechos duraderos para guardar")
        _capture_trace_fragment(
            "memory_commit",
            {
                "stored_records": len(commit_result.stored_records),
                "summary_refreshed": bool(updates.get("summary")),
                "updated_summary": updates.get("summary", ""),
            },
            label="memory-runtime",
        )
        return updates

    def _apply_state_update(self, state: GraphState, patch: dict[str, Any]) -> GraphState:
        merged: GraphState = deepcopy(state)
        for key, value in patch.items():
            if key == "appointment_slots" and isinstance(value, dict):
                existing = merged.get(key, {})
                merged[key] = _merge_slots(existing if isinstance(existing, dict) else {}, value)
            else:
                merged[key] = value
        return merged

    def _cleanup_state(self, state: GraphState) -> GraphState:
        cleaned: GraphState = deepcopy(state)
        if cleaned.get("next_node") != "appointment":
            cleaned["pending_action"] = ""
            cleaned["pending_question"] = ""
            cleaned["appointment_slots"] = {}
            if cleaned.get("stage") in {"collecting_slots", "ready_for_handoff"}:
                cleaned["stage"] = "open"
            if cleaned.get("active_goal") == "appointment" and not cleaned.get("handoff_required", False):
                cleaned["active_goal"] = "conversation"
        if cleaned.get("next_node") != "rag":
            cleaned["last_tool_result"] = ""
        return cleaned

    def _needs_summary_refresh(self, state: GraphState) -> bool:
        summary = state.get("summary", "")
        turn_count = int(state.get("turn_count", 0))
        if len(summary) >= self._settings.summary_refresh_char_threshold:
            return True
        if turn_count and turn_count % self._settings.summary_refresh_turn_threshold == 0:
            return True
        if state.get("next_node") == "appointment" and state.get("stage") == "ready_for_handoff":
            return True
        return False


def _merge_slots(existing: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    merged = dict(existing)
    for key in ("patient_name", "reason", "preferred_date", "preferred_time"):
        value = incoming.get(key)
        if value:
            merged[key] = value
    if incoming.get("missing_fields") is not None:
        merged["missing_fields"] = list(incoming.get("missing_fields") or [])
    if "confidence" in incoming:
        merged["confidence"] = incoming["confidence"]
    if "should_handoff" in incoming:
        merged["should_handoff"] = incoming["should_handoff"]
    return merged


def _build_pending_question(missing_fields: list[str]) -> str:
    field_names = {
        "patient_name": "el nombre del paciente",
        "reason": "el motivo o especialidad",
        "preferred_date": "la fecha preferida",
        "preferred_time": "la hora preferida",
    }
    readable = [field_names.get(field, field) for field in missing_fields]
    if not readable:
        return ""
    if len(readable) == 1:
        return f"Necesito {readable[0]} para continuar."
    if len(readable) == 2:
        return f"Necesito {readable[0]} y {readable[1]} para continuar."
    return "Necesito " + ", ".join(readable[:-1]) + f" y {readable[-1]} para continuar."


def _shorten(value: str, limit: int) -> str:
    compact = " ".join(value.split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 3] + "..."


def _build_short_term_state(state: GraphState) -> ShortTermState:
    return ShortTermState(
        summary=state.get("summary", ""),
        turn_count=int(state.get("turn_count", 0)),
        active_goal=state.get("active_goal", ""),
        stage=state.get("stage", ""),
        pending_action=state.get("pending_action", ""),
        pending_question=state.get("pending_question", ""),
        last_tool_result=state.get("last_tool_result", ""),
    )


def _build_domain_state(state: GraphState) -> dict[str, Any]:
    return {
        "appointment_slots": deepcopy(state.get("appointment_slots", {})),
        "handoff_required": state.get("handoff_required", False),
        "contact_name": state.get("contact_name", ""),
        "response_text": state.get("response_text", ""),
        "refresh_summary": state.get("summary_refresh_requested", False),
    }


def _build_reply_context(state: GraphState) -> ReplyContext:
    return ReplyContext(
        turn_count=int(state.get("turn_count", 0)),
        summary=state.get("summary", ""),
        active_goal=state.get("active_goal", ""),
        stage=state.get("stage", ""),
        pending_action=state.get("pending_action", ""),
        pending_question=state.get("pending_question", ""),
        last_assistant_message=state.get("last_assistant_message", ""),
        last_tool_result=state.get("last_tool_result", ""),
        appointment_slots=deepcopy(state.get("appointment_slots", {})),
        recent_turns=deepcopy(state.get("recent_turns", [])),
    )


def _append_recent_turn(
    recent_turns: list[dict[str, str]],
    *,
    user_message: str,
    assistant_message: str,
    limit: int = 3,
) -> list[dict[str, str]]:
    updated = [
        {
            "user": _shorten(turn.get("user", ""), 220),
            "assistant": _shorten(turn.get("assistant", ""), 220),
        }
        for turn in recent_turns
        if turn.get("user") or turn.get("assistant")
    ]
    updated.append(
        {
            "user": _shorten(user_message, 220),
            "assistant": _shorten(assistant_message, 220),
        }
    )
    return updated[-limit:]


def _capture_trace_fragment(kind: str, payload: dict[str, Any], *, label: str = "") -> None:
    trace_context = get_trace_context()
    if trace_context is None:
        return
    trace_context.capture_fragment(kind, payload, label=label)


def _reply_context_payload(context: ReplyContext) -> dict[str, Any]:
    return {
        "turn_count": context.turn_count,
        "summary": context.summary,
        "active_goal": context.active_goal,
        "stage": context.stage,
        "pending_action": context.pending_action,
        "pending_question": context.pending_question,
        "last_assistant_message": context.last_assistant_message,
        "last_tool_result": context.last_tool_result,
        "appointment_slots": deepcopy(context.appointment_slots),
        "recent_turns": deepcopy(context.recent_turns),
    }
