import httpx
import pytest

from app.services.qdrant import QdrantRetrievalService
from app.settings import Settings


def build_service() -> QdrantRetrievalService:
    settings = Settings(
        qdrant_enabled=True,
        qdrant_simulate=False,
        qdrant_base_url="http://qdrant.invalid:6333",
        qdrant_collection_name="clinic_knowledge",
    )
    return QdrantRetrievalService(settings)


async def _raise_connect_error(*args, **kwargs):
    del args, kwargs
    request = httpx.Request("POST", "http://qdrant.invalid:6333/collections/clinic_knowledge/points/search")
    raise httpx.ConnectError("All connection attempts failed", request=request)


def test_qdrant_search_returns_empty_when_connection_fails(monkeypatch):
    service = build_service()
    monkeypatch.setattr(service, "_http_search", _raise_connect_error)

    results = __import__("asyncio").run(service.search(query="horarios", contact_id="123"))

    assert results == []


def test_qdrant_build_context_degrades_gracefully_when_connection_fails(monkeypatch):
    service = build_service()
    monkeypatch.setattr(service, "_http_search", _raise_connect_error)

    context = __import__("asyncio").run(
        service.build_context(
            query="horarios",
            contact_id="123",
            clinic_context="Horario: lun-vie 9 a 6",
            memories=["Prefiere respuestas breves"],
        )
    )

    assert "Horario: lun-vie 9 a 6" in context
    assert "Prefiere respuestas breves" in context
    assert "Qdrant no disponible" in context
    assert "Sin resultados" in context


def test_qdrant_build_context_prioritizes_retrieved_fragments(monkeypatch):
    service = build_service()

    async def fake_search(*args, **kwargs):
        del args, kwargs
        from app.services.qdrant import QdrantSearchResult

        return [
            QdrantSearchResult(
                id="p1",
                score=0.91,
                payload={"text": "Horario general confirmado", "source_file": "doc.md"},
            )
        ]

    monkeypatch.setattr(service, "search", fake_search)

    context = __import__("asyncio").run(
        service.build_context(
            query="horarios",
            contact_id="123",
            clinic_context="Horario: lun-vie 9 a 6",
            memories=["Prefiere respuestas breves"],
        )
    )

    assert "Fragmentos recuperados desde Qdrant" in context
    assert "Horario general confirmado" in context
    assert "Contexto base de respaldo desde clinic.json" not in context


@pytest.mark.asyncio
async def test_qdrant_http_search_uses_embedding_vector_without_contact_filter(monkeypatch):
    service = build_service()
    captured = {}

    async def fake_embed_query(query: str):
        assert query == "horarios"
        return [0.1, 0.2, 0.3]

    class FakeResponse:
        status_code = 200
        text = '{"result":[]}'
        is_error = False

        def raise_for_status(self):
            return None

        def json(self):
            return {
                "result": [
                    {
                        "id": "p1",
                        "score": 0.9,
                        "payload": {"text": "Horario general", "source": "doc"},
                    }
                ]
            }

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            del args, kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            del exc_type, exc, tb
            return False

        async def post(self, url, json, headers):
            captured["url"] = url
            captured["json"] = json
            captured["headers"] = headers
            return FakeResponse()

    monkeypatch.setattr(service, "_embed_query", fake_embed_query)
    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)

    results = await service._http_search(query="horarios", contact_id="123", limit=3)

    assert results[0].id == "p1"
    assert captured["json"]["vector"] == [0.1, 0.2, 0.3]
    assert "filter" not in captured["json"]
