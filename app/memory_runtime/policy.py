from __future__ import annotations

from typing import Any, Protocol

from app.memory_runtime.types import LongTermMemoryRecord, ShortTermState, TurnMemoryInput


class MemoryPolicy(Protocol):
    def select_records(
        self,
        turn: TurnMemoryInput,
        short_term: ShortTermState,
        domain_state: dict[str, Any],
    ) -> list[LongTermMemoryRecord]:
        ...
