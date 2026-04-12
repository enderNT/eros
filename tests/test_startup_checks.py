import asyncio

from app.observability.startup_checks import collect_startup_connection_checks
from app.settings import Settings


def _result_map(results):
    return {item.name: item for item in results}


def test_startup_checks_report_disabled_backends():
    settings = Settings(
        memory_backend="in_memory",
        memory_postgres_dsn="",
        trace_backend="in_memory",
        trace_postgres_dsn="",
        qdrant_enabled=False,
        chatwoot_reply_enabled=False,
        llm_base_url=None,
        openai_base_url=None,
    )

    results = asyncio.run(collect_startup_connection_checks(settings))
    mapped = _result_map(results)

    assert mapped["postgres.memory"].status == "disabled"
    assert mapped["postgres.checkpoints"].status == "disabled"
    assert mapped["postgres.tracing"].status == "disabled"
    assert mapped["qdrant"].status == "disabled"
    assert mapped["chatwoot"].status == "disabled"
    assert mapped["llm"].status == "disabled"


def test_startup_checks_probe_enabled_http_services(monkeypatch):
    calls = []

    async def fake_probe(host, port, *, ssl, timeout_seconds=1.5):
        del timeout_seconds
        calls.append((host, port, ssl))

    monkeypatch.setattr("app.observability.startup_checks._probe_tcp_endpoint", fake_probe)
    monkeypatch.setattr("app.observability.startup_checks._probe_postgres_dsn", lambda dsn: fake_probe("postgres", 5432, ssl=False))

    settings = Settings(
        memory_backend="langgraph_postgres",
        memory_postgres_dsn="postgresql://user:pass@db.internal:5432/app",
        trace_backend="postgres",
        trace_postgres_dsn="postgresql://user:pass@trace.internal:5432/app",
        trace_postgres_schema="tracing",
        qdrant_enabled=True,
        qdrant_simulate=False,
        qdrant_base_url="http://qdrant.internal:6333",
        chatwoot_reply_enabled=True,
        chatwoot_api_base_url="https://chatwoot.internal",
        chatwoot_api_token="secret",
        chatwoot_account_id="1",
        llm_base_url="https://llm.internal/v1",
    )

    results = asyncio.run(collect_startup_connection_checks(settings))
    mapped = _result_map(results)

    assert mapped["postgres.memory"].status == "ok"
    assert mapped["postgres.checkpoints"].status == "ok"
    assert mapped["postgres.tracing"].status == "ok"
    assert mapped["qdrant"].status == "ok"
    assert mapped["chatwoot"].status == "ok"
    assert mapped["llm"].status == "ok"
    assert ("qdrant.internal", 6333, False) in calls
    assert ("chatwoot.internal", 443, True) in calls
    assert ("llm.internal", 443, True) in calls


def test_startup_checks_mark_failures_without_raising(monkeypatch):
    async def fake_probe(host, port, *, ssl, timeout_seconds=1.5):
        del host, port, ssl, timeout_seconds
        raise ConnectionRefusedError("boom")

    monkeypatch.setattr("app.observability.startup_checks._probe_tcp_endpoint", fake_probe)
    monkeypatch.setattr("app.observability.startup_checks._probe_postgres_dsn", lambda dsn: fake_probe("postgres", 5432, ssl=False))

    settings = Settings(
        memory_backend="langgraph_postgres",
        memory_postgres_dsn="postgresql://user:pass@db.internal:5432/app",
        trace_backend="postgres",
        trace_postgres_dsn="postgresql://user:pass@trace.internal:5432/app",
        qdrant_enabled=True,
        qdrant_simulate=False,
        qdrant_base_url="http://qdrant.internal:6333",
        chatwoot_reply_enabled=True,
        chatwoot_api_base_url="https://chatwoot.internal",
        chatwoot_api_token="secret",
        chatwoot_account_id="1",
    )

    results = asyncio.run(collect_startup_connection_checks(settings))
    mapped = _result_map(results)

    assert mapped["postgres.memory"].status == "failed"
    assert mapped["postgres.checkpoints"].status == "failed"
    assert mapped["postgres.tracing"].status == "failed"
    assert mapped["qdrant"].status == "failed"
    assert mapped["chatwoot"].status == "failed"
