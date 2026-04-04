from __future__ import annotations

import contextvars
import logging
import re
import textwrap
import time
import uuid

logger = logging.getLogger("clinica.flow")

_flow_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("flow_id", default="-")
_conversation_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("conversation_id", default="-")
_flow_started_at_var: contextvars.ContextVar[float] = contextvars.ContextVar("flow_started_at", default=0.0)

_SECTION_WIDTH = 108
_BLOCK_SEPARATOR = "=" * _SECTION_WIDTH
_SUBSECTION_SEPARATOR = "-" * _SECTION_WIDTH
_DETAIL_WIDTH = _SECTION_WIDTH - 6

_STEP_LABELS = {
    "webhook_received": "Webhook recibido",
    "webhook_payload_validated": "Validando payload",
    "webhook_background_dispatch": "Enviando a segundo plano",
    "semantic_routing_and_graph": "Procesando flujo principal",
    "build_context": "Preparando contexto",
    "clinic_config": "Cargando configuracion de la clinica",
    "memory_lookup": "Buscando memoria previa",
    "qdrant_lookup": "Consultando contexto RAG",
    "intent_router_openai": "Decidiendo intencion",
    "router_prompt_compose": "Preparando texto para clasificar",
    "router_match": "Ruta detectada",
    "router_fallback": "Usando ruta de respaldo",
    "state_router_guard": "Guard de ruteo",
    "state_router_llm": "Decision del router",
    "branch_selection": "Eligiendo camino del flujo",
    "conversation": "Yendo a conversacion general",
    "rag": "Yendo a respuesta con contexto",
    "appointment": "Yendo a gestion de cita",
    "conversation_node": "Generando respuesta general",
    "rag_node": "Generando respuesta con contexto",
    "appointment_node": "Extrayendo datos de la cita",
    "appointment_payload": "Revisando datos de la cita",
    "store_memory": "Guardando en memoria",
    "outbound_response": "Enviando respuesta a Chatwoot",
    "llm_chat_completion": "Consultando proveedor LLM",
    "llm_json_schema_retry": "Reintentando JSON compatible",
    "conversation_prompt_compose": "Preparando respuesta general",
    "conversation_fallback": "Usando respuesta general de respaldo",
    "rag_prompt_compose": "Preparando respuesta con contexto",
    "rag_fallback": "Usando respuesta RAG de respaldo",
    "appointment_prompt_compose": "Preparando extraccion de cita",
    "appointment_json_parse": "Leyendo datos estructurados",
    "appointment_fallback": "Usando extraccion de respaldo",
    "appointment_reply_prompt_compose": "Preparando respuesta de cita",
    "appointment_reply_fallback": "Usando respuesta de cita de respaldo",
    "flow_execution": "Ejecucion del flujo",
    "unknown_branch": "Ruta desconocida",
}


def configure_flow_logger(level: int = logging.INFO) -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.handlers.clear()
    logger.addHandler(handler)
    logger.setLevel(level)
    logger.propagate = False


def new_flow_id() -> str:
    return uuid.uuid4().hex[:10]


def bind_flow(flow_id: str, conversation_id: str) -> None:
    _flow_id_var.set(flow_id)
    _conversation_id_var.set(conversation_id)
    _flow_started_at_var.set(time.perf_counter())


def clear_flow() -> None:
    _flow_id_var.set("-")
    _conversation_id_var.set("-")
    _flow_started_at_var.set(0.0)


def get_flow_context() -> tuple[str, str]:
    return _flow_id_var.get(), _conversation_id_var.get()


def start_flow(message_preview: str) -> None:
    logger.info("")
    logger.info(_BLOCK_SEPARATOR)
    logger.info("FLOW START")
    logger.info(f"FLOW ID       {_flow_id_var.get()}")
    logger.info(f"CONVERSATION  {_conversation_id_var.get()}")
    logger.info(_SUBSECTION_SEPARATOR)
    logger.info("USER MESSAGE")
    for line in _wrap_text(_safe_preview(message_preview), _DETAIL_WIDTH):
        logger.info(f"  {line}")
    logger.info(_SUBSECTION_SEPARATOR)
    logger.info("STEPS")


def end_flow(status: str, detail: str = "") -> None:
    started_at = _flow_started_at_var.get()
    elapsed_ms = 0 if started_at == 0.0 else int((time.perf_counter() - started_at) * 1000)
    logger.info(_SUBSECTION_SEPARATOR)
    logger.info("RESULT")
    logger.info(f"  STATUS   {_status_label(status).upper()}")
    if detail:
        for line in _wrap_text(detail, _DETAIL_WIDTH - 11):
            logger.info(f"  DETAIL   {line}")
    logger.info(f"  ELAPSED  {elapsed_ms}ms")
    logger.info(_BLOCK_SEPARATOR)


def step(name: str, status: str = "RUN", detail: str = "") -> None:
    logger.info(_line(name=name, status=status, detail=detail, indent=0))


def substep(name: str, status: str = "RUN", detail: str = "") -> None:
    logger.info(_line(name=name, status=status, detail=detail, indent=2))


def mark_error(step_name: str, exc: Exception) -> None:
    step(step_name, "ERROR", f"{type(exc).__name__}: {exc}")


def _line(name: str, status: str, detail: str, indent: int) -> str:
    clean_name = _clean_name(name)
    bullet = "  -" if indent else "  *"
    lines = [f"{bullet} [{_status_code(status)}] {clean_name.upper()}"]
    for wrapped in _wrap_text(detail, _DETAIL_WIDTH):
        lines.append(f"      {wrapped}")
    return "\n".join(lines)


def _status_label(status: str) -> str:
    labels = {
        "RUN": "En curso",
        "OK": "Listo",
        "WARN": "Aviso",
        "ERROR": "Error",
    }
    return labels.get(status.upper(), status.title())


def _status_code(status: str) -> str:
    return {
        "RUN": "RUN",
        "OK": "OK",
        "WARN": "WARN",
        "ERROR": "ERR",
    }.get(status.upper(), status.upper()[:4])


def _wrap_text(value: str, width: int) -> list[str]:
    compact = str(value or "").strip()
    if not compact:
        return []
    return textwrap.wrap(compact, width=width, break_long_words=False, break_on_hyphens=False)


def _clean_name(name: str) -> str:
    base_name = re.sub(r"^[0-9]+(?:\.[0-9a-z]+)*(?:\s+)?", "", name, flags=re.IGNORECASE).strip()
    slug = re.sub(r"[^a-z0-9]+", "_", base_name.lower()).strip("_")
    if slug in _STEP_LABELS:
        return _STEP_LABELS[slug]
    return base_name.replace("_", " ")


def _safe_preview(message: str, max_len: int = 120) -> str:
    compact = " ".join(message.split())
    if len(compact) <= max_len:
        return compact
    return f"{compact[: max_len - 3]}..."
