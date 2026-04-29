from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from typing import Any

BRIGHT_SEPARATOR_COLORS = (92, 93, 94, 95, 96)
RED_COLOR = "\u001b[31m"
RESET_COLOR = "\u001b[0m"


def _short_id(value: str) -> str:
    return value.split("-", 1)[0]


def _compact_text(value: str, limit: int = 140) -> str:
    compact = " ".join(value.split()).strip()
    if len(compact) <= limit:
        return compact
    return f"{compact[: limit - 3]}..."


def _preview_payload(payload: dict[str, Any]) -> str:
    for key in ("user_message", "contact_name", "context_summary", "summary"):
        candidate = payload.get(key)
        if isinstance(candidate, str) and candidate.strip():
            return _compact_text(candidate)
    return _compact_text(json.dumps(sorted(payload.keys()), ensure_ascii=False))


class DspyOperationalLogger:
    def __init__(self, console_enabled: bool = True) -> None:
        self.console_enabled = console_enabled

    def log_startup(self, payload: dict[str, Any]) -> None:
        if not self.console_enabled:
            return
        self._write_separator(BRIGHT_SEPARATOR_COLORS[0], "start")
        self._write_line("IN", f"startup service=eros-dspy-runtime backend={payload.get('backend', 'unknown')}")
        self._write_line("LOAD", _compact_text(json.dumps(payload, ensure_ascii=False), 220))
        self._write_separator(BRIGHT_SEPARATOR_COLORS[0], "end")

    def log_system_error(self, stage: str, owner: str, error: Exception | str) -> None:
        if not self.console_enabled:
            return
        detail = error if isinstance(error, str) else str(error)
        self._write_line("FLOW", f"{stage} {owner}: {detail}", is_error=True)

    def start_run(self, task_name: str, payload: dict[str, Any]) -> "DspyExecutionLogger":
        return DspyExecutionLogger(
            parent=self,
            run_id=str(uuid.uuid4()),
            task_name=task_name,
            preview=_preview_payload(payload),
            color_code=BRIGHT_SEPARATOR_COLORS[hash(task_name) % len(BRIGHT_SEPARATOR_COLORS)],
        )

    def _write_line(self, phase: str, message: str, *, is_error: bool = False) -> None:
        if not self.console_enabled or not message.strip():
            return
        formatted = f"[{phase}]".ljust(8)
        if is_error:
            print(f"{RED_COLOR}{formatted}{message}{RESET_COLOR}")
            return
        print(f"{formatted}{message}")

    def _write_separator(self, color_code: int, direction: str) -> None:
        if not self.console_enabled:
            return
        bar = "═" * 60
        marker = "▼" if direction == "start" else "▲"
        line = f"{bar}{marker}" if direction == "start" else f"{marker}{bar}"
        print(f"\u001b[{color_code}m{line}{RESET_COLOR}")


@dataclass(slots=True)
class DspyExecutionLogger:
    parent: DspyOperationalLogger
    run_id: str
    task_name: str
    preview: str
    color_code: int

    def open(self) -> None:
        self.parent._write_separator(self.color_code, "start")
        self.parent._write_line("IN", f"run={_short_id(self.run_id)} task={self.task_name} input=\"{self.preview}\"")

    def load(self, summary: str, *, is_error: bool = False) -> None:
        self.parent._write_line("LOAD", summary, is_error=is_error)

    def flow(self, summary: str, *, is_error: bool = False) -> None:
        self.parent._write_line("FLOW", summary, is_error=is_error)

    def out(self, summary: str, *, is_error: bool = False) -> None:
        self.parent._write_line("OUT", summary, is_error=is_error)

    def end(self, status: str) -> None:
        self.parent._write_line("END", status)
        self.parent._write_separator(self.color_code, "end")

    def fail(self, error: Exception | str) -> None:
        detail = error if isinstance(error, str) else str(error)
        self.parent._write_line("FLOW", f"{self.task_name}: {detail}", is_error=True)
        self.parent._write_line("END", "error", is_error=True)
        self.parent._write_separator(self.color_code, "end")
