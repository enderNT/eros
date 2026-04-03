from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
import logging
from typing import Any

from langgraph.checkpoint.memory import MemorySaver

from app.settings import Settings

logger = logging.getLogger(__name__)


@asynccontextmanager
async def build_graph_checkpointer(settings: Settings) -> AsyncIterator[Any]:
    dsn = settings.memory_postgres_dsn or settings.trace_postgres_dsn
    if not dsn:
        logger.info("LangGraph short-term state is using in-memory checkpoints.")
        yield MemorySaver()
        return

    try:
        from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
    except ModuleNotFoundError as exc:  # pragma: no cover - depende del entorno
        raise RuntimeError(
            "LangGraph Postgres checkpoint saver is not installed. Install `langgraph-checkpoint-postgres` and `psycopg[binary,pool]`."
        ) from exc

    async with AsyncPostgresSaver.from_conn_string(dsn) as checkpointer:
        await checkpointer.setup()
        logger.info("LangGraph short-term state is using Postgres checkpoints.")
        yield checkpointer
