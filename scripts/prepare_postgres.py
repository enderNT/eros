from __future__ import annotations

import argparse
import asyncio
import json
from dataclasses import dataclass
from pathlib import Path
import sys
from typing import Any
from urllib.parse import urlsplit, urlunsplit

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from langgraph.store.postgres.aio import AsyncPostgresStore
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg import AsyncConnection
from psycopg.rows import dict_row

from app.memory_runtime.store import OpenAIEmbeddingsAdapter
from app.settings import Settings
from app.tracing.repository import PostgresTraceRepository


@dataclass(slots=True)
class PreparedConfig:
    input_dsn: str
    normalized_dsn: str
    normalized_scheme: bool
    memory_index_dims: int


def normalize_postgres_dsn(dsn: str) -> PreparedConfig:
    value = dsn.strip()
    if not value:
        raise ValueError("A PostgreSQL DSN is required.")

    parts = urlsplit(value)
    if parts.scheme == "postgres":
        normalized = urlunsplit(("postgresql", parts.netloc, parts.path, parts.query, parts.fragment))
        return PreparedConfig(
            input_dsn=value,
            normalized_dsn=normalized,
            normalized_scheme=True,
            memory_index_dims=1536,
        )

    return PreparedConfig(
        input_dsn=value,
        normalized_dsn=value,
        normalized_scheme=False,
        memory_index_dims=1536,
    )


async def prepare_database(
    dsn: str,
    *,
    memory_index_dims: int,
    embedding_model: str,
    llm_api_key: str | None,
    llm_base_url: str | None,
) -> dict[str, Any]:
    embedder = OpenAIEmbeddingsAdapter(
        api_key=llm_api_key,
        model=embedding_model,
        base_url=llm_base_url,
    )
    async with AsyncPostgresStore.from_conn_string(
        dsn,
        index={"dims": memory_index_dims, "embed": embedder, "fields": ["text"]},
    ) as store:
        await store.setup()

    async with AsyncPostgresSaver.from_conn_string(dsn) as checkpointer:
        await checkpointer.setup()

    trace_repository = PostgresTraceRepository(dsn)
    await trace_repository.setup()

    return await inspect_catalog(dsn)


async def inspect_catalog(dsn: str) -> dict[str, Any]:
    async with await AsyncConnection.connect(dsn, autocommit=True, row_factory=dict_row) as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT extname
                FROM pg_extension
                WHERE extname IN ('vector')
                ORDER BY extname
                """
            )
            extensions = [row["extname"] for row in await cur.fetchall()]

            await cur.execute(
                """
                SELECT table_schema, table_name
                FROM information_schema.tables
                WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
                  AND table_name IN (
                      'store',
                      'store_migrations',
                      'store_vectors',
                      'vector_migrations',
                      'checkpoints',
                      'checkpoint_blobs',
                      'checkpoint_writes',
                      'checkpoint_migrations',
                      'trace_turns',
                      'trace_fragments',
                      'trace_examples'
                  )
                ORDER BY table_schema, table_name
                """
            )
            tables = [dict(row) for row in await cur.fetchall()]

            await cur.execute(
                """
                SELECT schemaname, tablename, indexname, indexdef
                FROM pg_indexes
                WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
                  AND tablename IN (
                      'store',
                      'store_vectors',
                      'checkpoints',
                      'checkpoint_blobs',
                      'checkpoint_writes',
                      'trace_turns',
                      'trace_fragments',
                      'trace_examples'
                  )
                ORDER BY schemaname, tablename, indexname
                """
            )
            indexes = [dict(row) for row in await cur.fetchall()]

            await cur.execute(
                """
                SELECT
                    tc.table_schema,
                    tc.table_name,
                    tc.constraint_name,
                    tc.constraint_type
                FROM information_schema.table_constraints AS tc
                WHERE tc.table_schema NOT IN ('pg_catalog', 'information_schema')
                  AND tc.table_name IN (
                      'store',
                      'store_vectors',
                      'checkpoints',
                      'checkpoint_blobs',
                      'checkpoint_writes',
                      'trace_turns',
                      'trace_fragments',
                      'trace_examples'
                  )
                ORDER BY tc.table_schema, tc.table_name, tc.constraint_type, tc.constraint_name
                """
            )
            constraints = [dict(row) for row in await cur.fetchall()]

            await cur.execute(
                """
                SELECT
                    tc.table_schema,
                    tc.table_name,
                    tc.constraint_name,
                    kcu.column_name,
                    ccu.table_schema AS foreign_table_schema,
                    ccu.table_name AS foreign_table_name,
                    ccu.column_name AS foreign_column_name
                FROM information_schema.table_constraints AS tc
                JOIN information_schema.key_column_usage AS kcu
                  ON tc.constraint_name = kcu.constraint_name
                 AND tc.table_schema = kcu.table_schema
                JOIN information_schema.constraint_column_usage AS ccu
                  ON tc.constraint_name = ccu.constraint_name
                 AND tc.table_schema = ccu.table_schema
                WHERE tc.constraint_type = 'FOREIGN KEY'
                  AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
                  AND tc.table_name IN ('store_vectors', 'trace_fragments', 'trace_examples')
                ORDER BY tc.table_schema, tc.table_name, tc.constraint_name, kcu.ordinal_position
                """
            )
            foreign_keys = [dict(row) for row in await cur.fetchall()]

    return {
        "extensions": extensions,
        "tables": tables,
        "indexes": indexes,
        "constraints": constraints,
        "foreign_keys": foreign_keys,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Prepare the PostgreSQL objects required by the clinic assistant app."
    )
    parser.add_argument("--dsn", required=True, help="PostgreSQL connection string.")
    parser.add_argument(
        "--memory-index-dims",
        type=int,
        default=1536,
        help="Embedding dimensions used by LangGraph's Postgres store.",
    )
    return parser


async def _main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    settings = Settings()

    prepared = normalize_postgres_dsn(args.dsn)
    prepared.memory_index_dims = args.memory_index_dims
    catalog = await prepare_database(
        prepared.normalized_dsn,
        memory_index_dims=prepared.memory_index_dims,
        embedding_model=settings.openai_embedding_model,
        llm_api_key=settings.resolved_llm_api_key,
        llm_base_url=settings.resolved_llm_base_url,
    )

    output = {
        "normalized_scheme": prepared.normalized_scheme,
        "effective_scheme": urlsplit(prepared.normalized_dsn).scheme,
        "memory_index_dims": prepared.memory_index_dims,
        "catalog": catalog,
    }
    print(json.dumps(output, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
