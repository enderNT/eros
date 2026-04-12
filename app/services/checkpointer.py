from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
import inspect
import logging
from typing import Any

from langgraph.checkpoint.memory import MemorySaver

from app.settings import Settings

logger = logging.getLogger(__name__)


def _is_connection_error(exc: Exception) -> bool:
    if type(exc).__name__ in {"OperationalError", "InterfaceError"}:
        return True
    message = str(exc).lower()
    return any(
        fragment in message
        for fragment in (
            "connection is closed",
            "server closed the connection unexpectedly",
            "terminating connection",
            "connection not open",
            "consuming input failed",
        )
    )


def _build_async_postgres_saver_factory() -> Callable[[str], AbstractAsyncContextManager[Any]]:
    try:
        from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
    except ModuleNotFoundError as exc:  # pragma: no cover - depende del entorno
        raise RuntimeError(
            "LangGraph Postgres checkpoint saver is not installed. Install `langgraph-checkpoint-postgres` and `psycopg[binary,pool]`."
        ) from exc
    return AsyncPostgresSaver.from_conn_string


class ResilientAsyncPostgresCheckpointer:
    backend_name = "postgres"

    def __init__(
        self,
        dsn: str,
        *,
        saver_factory: Callable[[str], AbstractAsyncContextManager[Any]] | None = None,
        reconnect_retries: int = 1,
    ) -> None:
        self._dsn = dsn
        self._saver_factory = saver_factory or _build_async_postgres_saver_factory()
        self._reconnect_retries = max(1, reconnect_retries)
        self._lock = asyncio.Lock()
        self._saver_cm: AbstractAsyncContextManager[Any] | None = None
        self._saver: Any | None = None
        self._setup_complete = False

    async def setup(self) -> None:
        await self._ensure_saver()

    async def close(self) -> None:
        async with self._lock:
            await self._close_locked()

    async def probe(self) -> None:
        await self.aget_tuple({"configurable": {"thread_id": "__healthcheck__"}})

    async def _ensure_saver(self) -> Any:
        if self._saver is not None:
            return self._saver

        async with self._lock:
            if self._saver is None:
                await self._open_locked(run_setup=not self._setup_complete)
        return self._saver

    async def _reconnect(self) -> None:
        async with self._lock:
            await self._close_locked()
            await self._open_locked(run_setup=False)

    async def _open_locked(self, *, run_setup: bool) -> None:
        saver_cm = self._saver_factory(self._dsn)
        saver = await saver_cm.__aenter__()
        try:
            if run_setup:
                await saver.setup()
        except Exception as exc:
            await saver_cm.__aexit__(type(exc), exc, exc.__traceback__)
            raise
        self._saver_cm = saver_cm
        self._saver = saver
        self._setup_complete = True
        logger.info("LangGraph short-term state is using Postgres checkpoints.")

    async def _close_locked(self) -> None:
        saver_cm = self._saver_cm
        self._saver_cm = None
        self._saver = None
        if saver_cm is not None:
            await saver_cm.__aexit__(None, None, None)

    async def _call_with_reconnect(self, name: str, *args: Any, **kwargs: Any) -> Any:
        last_error: Exception | None = None
        for attempt in range(self._reconnect_retries + 1):
            saver = await self._ensure_saver()
            method = getattr(saver, name)
            try:
                result = method(*args, **kwargs)
                if inspect.isawaitable(result):
                    return await result
                return result
            except Exception as exc:
                last_error = exc
                if not _is_connection_error(exc) or attempt >= self._reconnect_retries:
                    raise
                logger.warning(
                    "Graph checkpointer call %s failed with %s. Reconnecting to Postgres and retrying.",
                    name,
                    type(exc).__name__,
                )
                await self._reconnect()
        if last_error is not None:
            raise last_error
        raise RuntimeError(f"Checkpointer call {name} failed without an exception.")

    def __getattr__(self, name: str) -> Any:
        async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
            return await self._call_with_reconnect(name, *args, **kwargs)

        return async_wrapper


@asynccontextmanager
async def build_graph_checkpointer(settings: Settings) -> AsyncIterator[Any]:
    dsn = settings.memory_postgres_dsn or settings.trace_postgres_dsn
    if not dsn:
        logger.info("LangGraph short-term state is using in-memory checkpoints.")
        yield MemorySaver()
        return

    checkpointer = ResilientAsyncPostgresCheckpointer(dsn)
    await checkpointer.setup()
    try:
        yield checkpointer
    finally:
        await checkpointer.close()
