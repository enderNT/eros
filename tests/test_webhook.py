from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.main import create_app
from app.services.runtime_monitor import BackgroundTaskMonitor
from app.settings import get_settings
from app.webhooks.routes import build_webhook_router


def build_test_client(monkeypatch) -> TestClient:
    get_settings.cache_clear()
    monkeypatch.setenv("LLM_API_KEY", "")
    monkeypatch.setenv("LLM_BASE_URL", "")
    monkeypatch.setenv("OPENAI_BASE_URL", "")
    monkeypatch.setenv("MEMORY_BACKEND", "in_memory")
    monkeypatch.setenv("MEMORY_POSTGRES_DSN", "")
    monkeypatch.setenv("TRACE_BACKEND", "in_memory")
    monkeypatch.setenv("TRACE_POSTGRES_DSN", "")
    monkeypatch.setenv("QDRANT_ENABLED", "false")
    monkeypatch.setenv("QDRANT_SIMULATE", "true")
    monkeypatch.setenv("CHATWOOT_REPLY_ENABLED", "false")
    monkeypatch.setenv("CHATWOOT_API_BASE_URL", "")
    monkeypatch.setenv("CHATWOOT_API_TOKEN", "")
    monkeypatch.setenv("CHATWOOT_ACCOUNT_ID", "")
    client = TestClient(create_app())
    client.__enter__()
    get_settings.cache_clear()
    return client


def test_healthcheck(monkeypatch):
    client = build_test_client(monkeypatch)
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["background_processing"]["status"] == "ok"


def test_healthcheck_with_dspy_flags_enabled(monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("LLM_API_KEY", "")
    monkeypatch.setenv("MEMORY_BACKEND", "in_memory")
    monkeypatch.setenv("MEMORY_POSTGRES_DSN", "")
    monkeypatch.setenv("TRACE_BACKEND", "in_memory")
    monkeypatch.setenv("TRACE_POSTGRES_DSN", "")
    monkeypatch.setenv("QDRANT_ENABLED", "false")
    monkeypatch.setenv("QDRANT_SIMULATE", "true")
    monkeypatch.setenv("CHATWOOT_REPLY_ENABLED", "false")
    monkeypatch.setenv("CHATWOOT_API_BASE_URL", "")
    monkeypatch.setenv("CHATWOOT_API_TOKEN", "")
    monkeypatch.setenv("CHATWOOT_ACCOUNT_ID", "")
    monkeypatch.setenv("LLM_BASE_URL", "")
    monkeypatch.setenv("OPENAI_BASE_URL", "")
    monkeypatch.setenv("DSPY_ENABLED", "true")
    monkeypatch.setenv("DSPY_ROUTER_ENABLED", "true")
    client = TestClient(create_app())

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_healthcheck_degrades_when_background_processing_failed(monkeypatch):
    client = build_test_client(monkeypatch)
    client.app.state.background_task_monitor.record_failure("321", "flow-1", RuntimeError("boom"))

    response = client.get("/health")

    assert response.status_code == 503
    payload = response.json()
    assert payload["status"] == "degraded"
    assert payload["background_processing"]["status"] == "degraded"


def test_chatwoot_webhook_accepts_immediately(monkeypatch):
    client = build_test_client(monkeypatch)
    payload = {
        "event": "message_created",
        "message_type": "incoming",
        "content": "Necesito una cita",
        "conversation": {"id": 321},
        "contact": {"id": 654, "name": "Maria"},
    }

    response = client.post("/webhooks/chatwoot", json=payload)

    assert response.status_code == 202
    assert response.json() == {"status": "accepted", "conversation_id": "321"}


def test_chatwoot_webhook_ignores_outgoing_messages(monkeypatch):
    class FakeAgentService:
        async def process_webhook(self, payload, flow_id=None):
            raise AssertionError("Outgoing events should not be processed")

    scheduled = []

    def fake_create_task(coro):
        scheduled.append(coro)
        coro.close()

    monkeypatch.setattr("app.webhooks.routes.asyncio.create_task", fake_create_task)

    app = FastAPI()
    app.include_router(build_webhook_router(FakeAgentService()))
    client = TestClient(app)

    response = client.post(
        "/webhooks/chatwoot",
        json={
            "event": "message_created",
            "message_type": "outgoing",
            "content": "respuesta del bot",
            "conversation": {"id": 321},
            "contact": {"id": 654, "name": "Maria"},
        },
    )

    assert response.status_code == 202
    assert response.json() == {"status": "ignored", "conversation_id": "321"}
    assert all(getattr(coro, "cr_code", None).co_name != "_safe_process" for coro in scheduled)


def test_safe_process_records_background_failures(monkeypatch):
    class FakeAgentService:
        async def process_webhook(self, payload, flow_id=None):
            del payload, flow_id
            raise RuntimeError("db down")

    monitor = BackgroundTaskMonitor()

    app = FastAPI()
    app.state.background_task_monitor = monitor
    app.include_router(build_webhook_router(FakeAgentService()))
    client = TestClient(app)

    response = client.post(
        "/webhooks/chatwoot",
        json={
            "event": "message_created",
            "message_type": "incoming",
            "content": "hola",
            "conversation": {"id": 321},
            "contact": {"id": 654, "name": "Maria"},
        },
    )

    assert response.status_code == 202
    snapshot = monitor.snapshot()
    assert snapshot["status"] == "degraded"
    assert snapshot["last_failure"]["conversation_id"] == "321"
