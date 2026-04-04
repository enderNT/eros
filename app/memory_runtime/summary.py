from __future__ import annotations

from typing import Protocol

from app.memory_runtime.types import ShortTermState, TurnMemoryInput
from app.tracing import get_trace_context


class ConversationSummaryService(Protocol):
    async def update(
        self,
        current_summary: str,
        turn: TurnMemoryInput,
        short_term: ShortTermState,
    ) -> str:
        ...


class LLMConversationSummaryService:
    def __init__(self, llm_service: object) -> None:
        self._llm_service = llm_service

    async def update(
        self,
        current_summary: str,
        turn: TurnMemoryInput,
        short_term: ShortTermState,
    ) -> str:
        updated_summary = await self._llm_service.build_state_summary(
            current_summary=current_summary,
            user_message=turn.user_message,
            assistant_message=turn.assistant_message,
            active_goal=short_term.active_goal,
            stage=short_term.stage,
        )
        trace_context = get_trace_context()
        if trace_context is not None:
            trace_context.capture_fragment(
                "state_summary",
                {
                    "current_summary": current_summary,
                    "user_message": turn.user_message,
                    "assistant_message": turn.assistant_message,
                    "active_goal": short_term.active_goal,
                    "stage": short_term.stage,
                    "updated_summary": updated_summary,
                },
                label="summary-service",
            )
        return updated_summary
