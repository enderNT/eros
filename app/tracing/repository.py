from __future__ import annotations

from collections.abc import Sequence
from contextlib import asynccontextmanager
from typing import Any, Protocol

from app.tracing.types import ProjectedExample, TraceRecord


class TraceRepository(Protocol):
    async def setup(self) -> None:
        ...

    async def save_batch(self, records: Sequence[TraceRecord], examples: Sequence[ProjectedExample]) -> None:
        ...


class InMemoryTraceRepository:
    def __init__(self) -> None:
        self.turns: dict[str, TraceRecord] = {}
        self.turns_by_dedupe_key: dict[str, str] = {}
        self.fragments: dict[str, list[dict[str, Any]]] = {}
        self.examples: dict[tuple[str, str, str], ProjectedExample] = {}

    async def setup(self) -> None:
        return None

    async def save_batch(self, records: Sequence[TraceRecord], examples: Sequence[ProjectedExample]) -> None:
        accepted_trace_ids: set[str] = set(self.turns.keys())
        for record in records:
            dedupe_key = record.envelope.dedupe_key
            if dedupe_key and dedupe_key in self.turns_by_dedupe_key:
                accepted_trace_ids.add(self.turns_by_dedupe_key[dedupe_key])
                continue

            trace_id = record.envelope.trace_id
            self.turns[trace_id] = record.model_copy(deep=True)
            self.fragments[trace_id] = [fragment.model_dump(mode="json") for fragment in record.fragments]
            accepted_trace_ids.add(trace_id)
            if dedupe_key:
                self.turns_by_dedupe_key[dedupe_key] = trace_id

        for example in examples:
            if example.trace_id not in accepted_trace_ids:
                continue
            key = (example.trace_id, example.task_name, example.projector_version)
            self.examples[key] = example.model_copy(deep=True)


class PostgresTraceRepository:
    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    async def setup(self) -> None:
        async with self._connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS trace_turns (
                        trace_id TEXT PRIMARY KEY,
                        parent_trace_id TEXT NULL,
                        session_key TEXT NOT NULL,
                        actor_key TEXT NOT NULL,
                        app_key TEXT NOT NULL,
                        flow_key TEXT NOT NULL,
                        dedupe_key TEXT UNIQUE NULL,
                        started_at TIMESTAMPTZ NOT NULL,
                        completed_at TIMESTAMPTZ NULL,
                        component_version TEXT NULL,
                        model_backend TEXT NULL,
                        model_name TEXT NULL,
                        outcome TEXT NOT NULL,
                        has_error BOOLEAN NOT NULL DEFAULT FALSE,
                        projector_eligibility_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
                        input_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                        output_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                        error_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                        metrics_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                        tags JSONB NOT NULL DEFAULT '{}'::jsonb,
                        extra_payload JSONB NOT NULL DEFAULT '{}'::jsonb
                    );
                    """
                )
                await cur.execute("CREATE INDEX IF NOT EXISTS idx_trace_turns_session_key ON trace_turns(session_key);")
                await cur.execute("CREATE INDEX IF NOT EXISTS idx_trace_turns_actor_key ON trace_turns(actor_key);")
                await cur.execute("CREATE INDEX IF NOT EXISTS idx_trace_turns_flow_key ON trace_turns(flow_key);")
                await cur.execute("CREATE INDEX IF NOT EXISTS idx_trace_turns_started_at ON trace_turns(started_at);")
                await cur.execute("CREATE INDEX IF NOT EXISTS idx_trace_turns_outcome ON trace_turns(outcome);")
                await cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS trace_fragments (
                        trace_id TEXT NOT NULL REFERENCES trace_turns(trace_id) ON DELETE CASCADE,
                        "order" INTEGER NOT NULL,
                        kind TEXT NOT NULL,
                        label TEXT NOT NULL DEFAULT '',
                        created_at TIMESTAMPTZ NOT NULL,
                        latency_ms INTEGER NULL,
                        token_usage JSONB NOT NULL DEFAULT '{}'::jsonb,
                        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                        PRIMARY KEY (trace_id, "order")
                    );
                    """
                )
                await cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS trace_examples (
                        trace_id TEXT NOT NULL REFERENCES trace_turns(trace_id) ON DELETE CASCADE,
                        task_name TEXT NOT NULL,
                        projector_version TEXT NOT NULL,
                        created_at TIMESTAMPTZ NOT NULL,
                        split TEXT NOT NULL DEFAULT 'train',
                        quality_label TEXT NULL,
                        input_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                        target_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                        metadata_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                        eligibility_reason TEXT NOT NULL DEFAULT '',
                        PRIMARY KEY (trace_id, task_name, projector_version)
                    );
                    """
                )
            await conn.commit()

    async def save_batch(self, records: Sequence[TraceRecord], examples: Sequence[ProjectedExample]) -> None:
        if not records and not examples:
            return

        from psycopg.types.json import Jsonb

        async with self._connection() as conn:
            async with conn.cursor() as cur:
                for record in records:
                    await cur.execute(
                        """
                        INSERT INTO trace_turns (
                            trace_id, parent_trace_id, session_key, actor_key, app_key, flow_key, dedupe_key,
                            started_at, completed_at, component_version, model_backend, model_name, outcome,
                            has_error, projector_eligibility_summary, input_payload, output_payload, error_payload,
                            metrics_payload, tags, extra_payload
                        ) VALUES (
                            %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                        )
                        ON CONFLICT DO NOTHING
                        """,
                        (
                            record.envelope.trace_id,
                            record.envelope.parent_trace_id,
                            record.envelope.session_key,
                            record.envelope.actor_key,
                            record.envelope.app_key,
                            record.envelope.flow_key,
                            record.envelope.dedupe_key,
                            record.envelope.started_at,
                            record.completed_at,
                            record.envelope.component_version,
                            record.envelope.model_backend,
                            record.envelope.model_name,
                            record.outcome,
                            bool(record.error_payload),
                            Jsonb(record.projector_eligibility_summary),
                            Jsonb(record.input_payload),
                            Jsonb(record.output_payload),
                            Jsonb(record.error_payload),
                            Jsonb(record.metrics_payload),
                            Jsonb(record.tags),
                            Jsonb(record.extra_payload),
                        ),
                    )
                    for fragment in record.fragments:
                        await cur.execute(
                            """
                            INSERT INTO trace_fragments (
                                trace_id, "order", kind, label, created_at, latency_ms, token_usage, payload
                            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                            ON CONFLICT (trace_id, "order") DO NOTHING
                            """,
                            (
                                record.envelope.trace_id,
                                fragment.order,
                                fragment.kind,
                                fragment.label,
                                fragment.created_at,
                                fragment.latency_ms,
                                Jsonb(fragment.token_usage),
                                Jsonb(fragment.payload),
                            ),
                        )
                for example in examples:
                    await cur.execute(
                        """
                        INSERT INTO trace_examples (
                            trace_id, task_name, projector_version, created_at, split, quality_label,
                            input_payload, target_payload, metadata_payload, eligibility_reason
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (trace_id, task_name, projector_version) DO UPDATE SET
                            created_at = EXCLUDED.created_at,
                            split = EXCLUDED.split,
                            quality_label = EXCLUDED.quality_label,
                            input_payload = EXCLUDED.input_payload,
                            target_payload = EXCLUDED.target_payload,
                            metadata_payload = EXCLUDED.metadata_payload,
                            eligibility_reason = EXCLUDED.eligibility_reason
                        """,
                        (
                            example.trace_id,
                            example.task_name,
                            example.projector_version,
                            example.created_at,
                            example.split,
                            example.quality_label,
                            Jsonb(example.input_payload),
                            Jsonb(example.target_payload),
                            Jsonb(example.metadata_payload),
                            example.eligibility_reason,
                        ),
                    )
            await conn.commit()

    @asynccontextmanager
    async def _connection(self):
        from psycopg import AsyncConnection

        conn = await AsyncConnection.connect(self._dsn)
        try:
            yield conn
        finally:
            await conn.close()
