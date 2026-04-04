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

_RESET = "\033[0m"
_BOLD = "\033[1m"
_DIM = "\033[2m"
_CYAN = "\033[36m"
_BLUE = "\033[34m"
_GREEN = "\033[32m"
_YELLOW = "\033[33m"
_RED = "\033[31m"
_TABLE_INNER_WIDTH = 102
_STATUS_WIDTH = 10
_STEP_WIDTH = 30
_DETAIL_WIDTH = _TABLE_INNER_WIDTH - _STATUS_WIDTH - _STEP_WIDTH - 8
_BORDER = "+" + "-" * _TABLE_INNER_WIDTH + "+"
_HEADER_BORDER = "+" + "-" * _STATUS_WIDTH + "+" + "-" * (_STEP_WIDTH + 2) + "+" + "-" * (_DETAIL_WIDTH + 2) + "+"

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
    logger.info(_BORDER)
    logger.info(_banner_row(f"FLOW {_flow_id_var.get()} | CONVERSATION {_conversation_id_var.get()}"))
    logger.info(_BORDER)
    logger.info(_banner_row("USER"))
    for line in _wrap_text(_safe_preview(message_preview), _TABLE_INNER_WIDTH - 2):
        logger.info(_banner_row(line))
    logger.info(_HEADER_BORDER)
    logger.info(_table_header())
    logger.info(_HEADER_BORDER)


def end_flow(status: str, detail: str = "") -> None:
    started_at = _flow_started_at_var.get()
    elapsed_ms = 0 if started_at == 0.0 else int((time.perf_counter() - started_at) * 1000)
    suffix = f"{detail} | elapsed={elapsed_ms}ms" if detail else f"elapsed={elapsed_ms}ms"
    for line in _table_lines("RESULT", status, suffix):
        logger.info(line)
    logger.info(_HEADER_BORDER)
    logger.info(_BORDER)


def step(name: str, status: str = "RUN", detail: str = "") -> None:
    logger.info(_line(name=name, status=status, detail=detail, indent=0))


def substep(name: str, status: str = "RUN", detail: str = "") -> None:
    logger.info(_line(name=name, status=status, detail=detail, indent=2))


def mark_error(step_name: str, exc: Exception) -> None:
    step(step_name, "ERROR", f"{type(exc).__name__}: {exc}")


def _line(name: str, status: str, detail: str, indent: int) -> str:
    clean_name = _clean_name(name)
    if indent:
        clean_name = f"> {clean_name}"
    return "\n".join(_table_lines(clean_name, status, detail))


def _status_label(status: str) -> str:
    labels = {
        "RUN": "En curso",
        "OK": "Listo",
        "WARN": "Aviso",
        "ERROR": "Error",
    }
    return labels.get(status.upper(), status.title())


def _status_color(status: str) -> str:
    colors = {
        "RUN": _BLUE,
        "OK": _GREEN,
        "WARN": _YELLOW,
        "ERROR": _RED,
    }
    return colors.get(status.upper(), _CYAN)


def _table_header() -> str:
    return f"| {'STATUS':<{_STATUS_WIDTH}} | {'STEP':<{_STEP_WIDTH}} | {'DETAIL':<{_DETAIL_WIDTH}} |"


def _table_lines(step_name: str, status: str, detail: str) -> list[str]:
    label = _status_label(status).upper()
    detail_lines = _wrap_text(detail, _DETAIL_WIDTH) or [""]
    step_lines = _wrap_text(step_name, _STEP_WIDTH) or [""]
    row_count = max(len(detail_lines), len(step_lines))
    lines: list[str] = []
    for index in range(row_count):
        status_text = label if index == 0 else ""
        step_text = step_lines[index] if index < len(step_lines) else ""
        detail_text = detail_lines[index] if index < len(detail_lines) else ""
        lines.append(
            f"| {status_text:<{_STATUS_WIDTH}} | {step_text:<{_STEP_WIDTH}} | {detail_text:<{_DETAIL_WIDTH}} |"
        )
    return lines


def _banner_row(text: str) -> str:
    return f"| {text:<{_TABLE_INNER_WIDTH - 2}} |"


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
