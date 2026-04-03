from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, Field


def utc_now() -> datetime:
    return datetime.now(UTC)


class TraceEnvelope(BaseModel):
    trace_id: str
    parent_trace_id: str | None = None
    session_key: str
    actor_key: str
    app_key: str
    flow_key: str
    dedupe_key: str | None = None
    started_at: datetime = Field(default_factory=utc_now)
    component_version: str | None = None
    model_backend: str | None = None
    model_name: str | None = None


class TraceFragment(BaseModel):
    kind: str
    order: int
    label: str = ""
    payload: dict[str, Any] = Field(default_factory=dict)
    latency_ms: int | None = None
    token_usage: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=utc_now)


class TraceRecord(BaseModel):
    envelope: TraceEnvelope
    input_payload: dict[str, Any] = Field(default_factory=dict)
    fragments: list[TraceFragment] = Field(default_factory=list)
    output_payload: dict[str, Any] = Field(default_factory=dict)
    error_payload: dict[str, Any] = Field(default_factory=dict)
    metrics_payload: dict[str, Any] = Field(default_factory=dict)
    tags: dict[str, Any] = Field(default_factory=dict)
    extra_payload: dict[str, Any] = Field(default_factory=dict)
    completed_at: datetime | None = None
    outcome: str = "unknown"
    projector_eligibility_summary: dict[str, Any] = Field(default_factory=dict)


class ProjectedExample(BaseModel):
    trace_id: str
    task_name: str
    projector_version: str
    input_payload: dict[str, Any] = Field(default_factory=dict)
    target_payload: dict[str, Any] = Field(default_factory=dict)
    metadata_payload: dict[str, Any] = Field(default_factory=dict)
    eligibility_reason: str = ""
    created_at: datetime = Field(default_factory=utc_now)
    split: str = "train"
    quality_label: str | None = None
