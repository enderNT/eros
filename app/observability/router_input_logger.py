from __future__ import annotations

import json
import logging
from typing import Any

_logger = logging.getLogger("clinica.router_input")
_enabled = False
_SEPARATOR = "-" * 96


def configure_router_input_logger(enabled: bool) -> None:
    global _enabled
    _enabled = enabled

    if not enabled:
        _logger.handlers.clear()
        _logger.propagate = False
        return

    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(message)s"))
    _logger.handlers.clear()
    _logger.addHandler(handler)
    _logger.setLevel(logging.INFO)
    _logger.propagate = False


def log_router_input(router_input: Any) -> None:
    if not _enabled:
        return
    rendered = _indent_block(_stringify(router_input))
    _logger.info("%s\nROUTER INPUT\n%s\n%s", _SEPARATOR, rendered, _SEPARATOR)


def _indent_block(value: str) -> str:
    lines = [line.rstrip() for line in value.strip().splitlines() if line.strip()]
    return "\n".join(f"  {line}" for line in lines) if lines else "  (empty)"


def _stringify(value: Any) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)
