import httpx

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
