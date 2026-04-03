from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from app.memory_runtime import (
    ConversationMemoryRuntime,
    InMemoryLongTermMemoryStore,
    LLMConversationSummaryService,
)
from app.memory_runtime.store import LangGraphPostgresMemoryStore, OpenAIEmbeddingsAdapter
from app.services.barbershop_memory import BarbershopMemoryPolicy
from app.settings import Settings

logger = logging.getLogger(__name__)


@asynccontextmanager
async def build_memory_runtime(settings: Settings, llm_service: object) -> AsyncIterator[ConversationMemoryRuntime]:
    if settings.memory_backend != "langgraph_postgres":
        yield _build_runtime(InMemoryLongTermMemoryStore(), llm_service)
        return

    if not settings.memory_postgres_dsn:
        raise RuntimeError("`memory_postgres_dsn` is required when `memory_backend=langgraph_postgres`.")

    try:
        from langgraph.store.postgres.aio import AsyncPostgresStore
    except ModuleNotFoundError as exc:  # pragma: no cover - depende del entorno
        raise RuntimeError(
            "LangGraph Postgres store is not installed. Install `langgraph-checkpoint-postgres` and `psycopg[binary,pool]`."
        ) from exc

    embedder = OpenAIEmbeddingsAdapter(
        api_key=settings.resolved_llm_api_key,
        model=settings.openai_embedding_model,
        base_url=settings.resolved_llm_base_url,
    )

    async with AsyncPostgresStore.from_conn_string(
        settings.memory_postgres_dsn,
        index={"dims": settings.memory_postgres_index_dims, "embed": embedder, "fields": ["text"]},
    ) as store:
        if settings.memory_postgres_setup_on_start:
            await store.setup()
        yield _build_runtime(LangGraphPostgresMemoryStore(store=store), llm_service)


def _build_runtime(store: object, llm_service: object) -> ConversationMemoryRuntime:
    return ConversationMemoryRuntime(
        store=store,
        summary_service=LLMConversationSummaryService(llm_service),
        policy=BarbershopMemoryPolicy(),
    )
