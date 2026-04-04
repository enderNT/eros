from __future__ import annotations

from datetime import datetime
import logging
import sys

from app.observability.flow_logger import get_flow_context

_RESET = "\033[0m"
_DIM = "\033[2m"
_BLUE = "\033[34m"
_GREEN = "\033[32m"
_YELLOW = "\033[33m"
_RED = "\033[31m"


class ConsoleFormatter(logging.Formatter):
    def __init__(self, *, use_color: bool | None = None) -> None:
        super().__init__()
        self._use_color = sys.stderr.isatty() if use_color is None else use_color

    def format(self, record: logging.LogRecord) -> str:
        timestamp = datetime.fromtimestamp(record.created).strftime("%H:%M:%S")
        level = _normalize_level(record.levelname)
        level_text = _colorize(level, _level_color(level), enabled=self._use_color)
        logger_name = _compact_logger_name(record.name)
        message = record.getMessage()
        flow_id, conversation_id = get_flow_context()
        scope = ""
        if flow_id != "-" or conversation_id != "-":
            scope_text = f"flow={flow_id} conv={conversation_id}"
            scope = " " + _colorize(scope_text, _DIM, enabled=self._use_color)
        rendered = f"{timestamp} {level_text:<14} {logger_name:<18} {message}{scope}"
        if record.exc_info:
            rendered += "\n" + self.formatException(record.exc_info)
        return rendered


def configure_console_logging(level: int = logging.INFO) -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(ConsoleFormatter())

    root_logger = logging.getLogger()
    root_logger.handlers.clear()
    root_logger.addHandler(handler)
    root_logger.setLevel(level)


def _normalize_level(level_name: str) -> str:
    normalized = level_name.upper()
    return {
        "DEBUG": "DEBUG",
        "INFO": "INFO",
        "WARNING": "WARN",
        "ERROR": "ERROR",
        "CRITICAL": "CRIT",
    }.get(normalized, normalized[:5])


def _compact_logger_name(name: str) -> str:
    if name.startswith("app."):
        return name[4:]
    if name.startswith("uvicorn."):
        return name
    return name


def _level_color(level_name: str) -> str:
    return {
        "DEBUG": _DIM,
        "INFO": _BLUE,
        "WARN": _YELLOW,
        "ERROR": _RED,
        "CRIT": _RED,
    }.get(level_name, _GREEN)


def _colorize(text: str, color: str, *, enabled: bool) -> str:
    if not enabled:
        return text
    return f"{color}{text}{_RESET}"
