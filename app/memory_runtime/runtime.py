from __future__ import annotations

from typing import Any

from app.memory_runtime.policy import MemoryPolicy
from app.memory_runtime.store import LongTermMemoryStore
from app.memory_runtime.summary import ConversationSummaryService
from app.memory_runtime.types import (
    MemoryCommitResult,
    MemoryContext,
    ShortTermState,
    TurnMemoryInput,
)


class ConversationMemoryRuntime:
    def __init__(
        self,
        store: LongTermMemoryStore,
        summary_service: ConversationSummaryService,
        policy: MemoryPolicy,
    ) -> None:
        self._store = store
        self._summary_service = summary_service
        self._policy = policy

    async def load_context(
        self,
        session_id: str,
        actor_id: str,
        query: str,
        short_term: ShortTermState,
    ) -> MemoryContext:
        del session_id
        records = await self._store.search(actor_id, query=query, limit=5)
        return MemoryContext(
            recalled_memories=[record.text for record in records],
            raw_records=records,
            turn_count=int(short_term.turn_count) + 1,
        )

    async def commit_turn(
        self,
        session_id: str,
        actor_id: str,
        turn: TurnMemoryInput,
        short_term: ShortTermState,
        domain_state: dict[str, Any],
    ) -> MemoryCommitResult:
        del session_id
        refresh_summary = bool(domain_state.get("refresh_summary", False))
        summary = short_term.summary
        if refresh_summary:
            summary = await self._summary_service.update(short_term.summary, turn, short_term)
        records = self._policy.select_records(turn, short_term, domain_state)
        if records:
            await self._store.save(actor_id, records)
        return MemoryCommitResult(
            summary=summary,
            stored_records=records,
            turn_count=int(short_term.turn_count),
        )
