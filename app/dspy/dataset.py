from __future__ import annotations

from collections import defaultdict
from pathlib import Path
import json
import re
from typing import Any

from pydantic import BaseModel, Field


class DSPyDatasetExample(BaseModel):
    trace_id: str
    task_name: str
    projector_version: str
    input_payload: dict[str, Any] = Field(default_factory=dict)
    target_payload: dict[str, Any] = Field(default_factory=dict)
    metadata_payload: dict[str, Any] = Field(default_factory=dict)
    fragment_payloads: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)

    def to_jsonl_row(self) -> str:
        return json.dumps(self.model_dump(mode="json"), ensure_ascii=False)


class PostgresDSPyDatasetStore:
    def __init__(self, dsn: str, schema: str = "tracing") -> None:
        self._dsn = dsn
        self._schema = _validate_schema_name(schema)

    async def fetch_examples(
        self,
        *,
        task_names: list[str] | None = None,
        limit: int | None = None,
    ) -> list[DSPyDatasetExample]:
        from psycopg import AsyncConnection

        trace_examples = self._qualified_table("trace_examples")
        trace_turns = self._qualified_table("trace_turns")
        trace_fragments = self._qualified_table("trace_fragments")
        query = f"""
            SELECT
                e.trace_id,
                e.task_name,
                e.projector_version,
                e.input_payload,
                e.target_payload,
                e.metadata_payload,
                COALESCE(
                    jsonb_agg(
                        jsonb_build_object(
                            'kind', f.kind,
                            'label', f.label,
                            'order', f."order",
                            'payload', f.payload
                        )
                        ORDER BY f."order"
                    ) FILTER (WHERE f.trace_id IS NOT NULL),
                    '[]'::jsonb
                ) AS fragments
            FROM {trace_examples} e
            INNER JOIN {trace_turns} t ON t.trace_id = e.trace_id
            LEFT JOIN {trace_fragments} f ON f.trace_id = e.trace_id
            WHERE t.outcome = 'success'
        """
        params: list[Any] = []
        if task_names:
            query += " AND e.task_name = ANY(%s)"
            params.append(task_names)
        query += """
            GROUP BY e.trace_id, e.task_name, e.projector_version, e.input_payload, e.target_payload, e.metadata_payload
            ORDER BY e.task_name, e.trace_id
        """
        if limit is not None:
            query += " LIMIT %s"
            params.append(limit)

        async with await AsyncConnection.connect(self._dsn) as conn:
            async with conn.cursor() as cur:
                await cur.execute(query, params)
                rows = await cur.fetchall()
        return [self._normalize_row(row) for row in rows]

    async def export_jsonl(
        self,
        output_dir: Path,
        *,
        task_names: list[str] | None = None,
        limit: int | None = None,
    ) -> dict[str, Path]:
        output_dir.mkdir(parents=True, exist_ok=True)
        examples = await self.fetch_examples(task_names=task_names, limit=limit)
        grouped: dict[str, list[DSPyDatasetExample]] = defaultdict(list)
        for example in examples:
            grouped[example.task_name].append(example)

        written: dict[str, Path] = {}
        for task_name, task_examples in grouped.items():
            file_path = output_dir / f"{task_name}.jsonl"
            file_path.write_text(
                "\n".join(example.to_jsonl_row() for example in task_examples) + ("\n" if task_examples else ""),
                encoding="utf-8",
            )
            written[task_name] = file_path
        return written

    def _normalize_row(self, row: tuple[Any, ...]) -> DSPyDatasetExample:
        trace_id, task_name, projector_version, input_payload, target_payload, metadata_payload, fragments = row
        fragment_payloads: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for fragment in fragments or []:
            kind = str(fragment.get("kind") or "unknown")
            fragment_payloads[kind].append(
                {
                    "label": fragment.get("label", ""),
                    "order": fragment.get("order"),
                    "payload": fragment.get("payload", {}),
                }
            )
        return DSPyDatasetExample(
            trace_id=str(trace_id),
            task_name=str(task_name),
            projector_version=str(projector_version),
            input_payload=dict(input_payload or {}),
            target_payload=dict(target_payload or {}),
            metadata_payload=dict(metadata_payload or {}),
            fragment_payloads=dict(fragment_payloads),
        )

    def _qualified_table(self, table_name: str) -> str:
        return f'"{self._schema}"."{table_name}"'


def _validate_schema_name(schema: str) -> str:
    value = schema.strip()
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value):
        raise ValueError(f"Invalid PostgreSQL schema name: {schema!r}")
    return value
