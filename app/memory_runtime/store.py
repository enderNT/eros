from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping
from itertools import islice
from typing import Any, Protocol
from uuid import uuid4

from langgraph.store.memory import InMemoryStore

from app.memory_runtime.types import LongTermMemoryRecord

logger = logging.getLogger(__name__)


def _unwrap_store_results(results: Any) -> Any:
    current = results
    for _ in range(3):
        if not isinstance(current, Mapping):
            return current
        for key in ("results", "memories", "items"):
            if key in current:
                current = current[key]
                break
        else:
            return current
    return current


def _extract_record_payload(item: Any) -> dict[str, Any]:
    if isinstance(item, Mapping):
        if isinstance(item.get("value"), Mapping):
            return dict(item["value"])
        return dict(item)

    value = getattr(item, "value", None)
    if isinstance(value, Mapping):
        return dict(value)

    payload: dict[str, Any] = {}
    for attr in ("kind", "text", "source", "created_at", "metadata", "memory", "content"):
        value = getattr(item, attr, None)
        if value is not None:
            payload[attr] = value
    return payload


def _normalize_store_search_results(results: Any, limit: int) -> list[LongTermMemoryRecord]:
    raw_items = _unwrap_store_results(results)
    if raw_items is None:
        return []
    if isinstance(raw_items, Mapping):
        logger.warning("Memory search returned an unexpected mapping shape: keys=%s", sorted(raw_items.keys()))
        return []
    if isinstance(raw_items, (str, bytes)):
        raw_items = [raw_items]
    elif not isinstance(raw_items, Iterable):
        raw_items = [raw_items]

    records: list[LongTermMemoryRecord] = []
    for item in islice(raw_items, limit):
        if isinstance(item, (str, bytes)):
            text = str(item).strip()
            if text:
                records.append(LongTermMemoryRecord(kind="episode", text=text))
            continue

        payload = _extract_record_payload(item)
        text = str(payload.get("text") or payload.get("memory") or payload.get("content") or "").strip()
        if not text:
            continue
        records.append(
            LongTermMemoryRecord(
                kind=str(payload.get("kind") or "episode"),
                text=text,
                source=str(payload.get("source") or "stateful-flow"),
                created_at=str(payload.get("created_at") or LongTermMemoryRecord(kind="episode", text=text).created_at),
                metadata=dict(payload.get("metadata") or {}),
            )
        )
    return records


class LongTermMemoryStore(Protocol):
    async def search(self, actor_id: str, query: str, limit: int = 5) -> list[LongTermMemoryRecord]:
        ...

    async def save(self, actor_id: str, records: list[LongTermMemoryRecord]) -> None:
        ...


class InMemoryLongTermMemoryStore:
    def __init__(self) -> None:
        self._store = InMemoryStore()

    async def search(self, actor_id: str, query: str, limit: int = 5) -> list[LongTermMemoryRecord]:
        results = await self._store.asearch(("memories", actor_id), query=query, limit=limit)
        return _normalize_store_search_results(results, limit=limit)

    async def save(self, actor_id: str, records: list[LongTermMemoryRecord]) -> None:
        for record in records:
            await self._store.aput(
                ("memories", actor_id),
                str(uuid4()),
                record.model_dump(),
                index=["text"],
            )


class OpenAIEmbeddingsAdapter:
    def __init__(self, api_key: str | None, model: str, base_url: str | None = None) -> None:
        from openai import OpenAI

        client_kwargs: dict[str, Any] = {}
        if api_key:
            client_kwargs["api_key"] = api_key
        if base_url:
            client_kwargs["base_url"] = base_url
        self._client = OpenAI(**client_kwargs)
        self._model = model

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        response = self._client.embeddings.create(model=self._model, input=texts)
        return [list(item.embedding) for item in response.data]

    def embed_query(self, text: str) -> list[float]:
        vectors = self.embed_documents([text])
        return vectors[0] if vectors else []

    def __call__(self, texts: list[str]) -> list[list[float]]:
        return self.embed_documents(texts)


class LangGraphPostgresMemoryStore:
    def __init__(
        self,
        *,
        store: Any,
        namespace: str = "memories",
    ) -> None:
        self._store = store
        self._namespace = namespace

    async def search(self, actor_id: str, query: str, limit: int = 5) -> list[LongTermMemoryRecord]:
        namespace = (self._namespace, actor_id)
        results = await self._store.asearch(namespace, query=query, limit=limit)
        return _normalize_store_search_results(results, limit=limit)

    async def save(self, actor_id: str, records: list[LongTermMemoryRecord]) -> None:
        if not records:
            return

        namespace = (self._namespace, actor_id)
        for record in records:
            await self._store.aput(
                namespace,
                str(uuid4()),
                record.model_dump(),
                index=["text"],
            )
