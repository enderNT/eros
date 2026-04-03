from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, TypeAlias

from pydantic import BaseModel, Field

SessionId: TypeAlias = str
ActorId: TypeAlias = str


class ShortTermState(BaseModel):
    summary: str = ""
    turn_count: int = 0
    active_goal: str = ""
    stage: str = ""
    pending_action: str = ""
    pending_question: str = ""
    last_tool_result: str = ""


class LongTermMemoryRecord(BaseModel):
    kind: str
    text: str
    source: str = "stateful-flow"
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    metadata: dict[str, Any] = Field(default_factory=dict)


class MemoryContext(BaseModel):
    recalled_memories: list[str] = Field(default_factory=list)
    raw_records: list[LongTermMemoryRecord] = Field(default_factory=list)
    turn_count: int = 0


class TurnMemoryInput(BaseModel):
    user_message: str = ""
    assistant_message: str = ""
    route: str = "conversation"


class MemoryCommitResult(BaseModel):
    summary: str = ""
    stored_records: list[LongTermMemoryRecord] = Field(default_factory=list)
    turn_count: int = 0

