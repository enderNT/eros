from __future__ import annotations

import asyncio
from dataclasses import dataclass
import logging
from urllib.parse import urlsplit

from app.settings import Settings

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class StartupCheckResult:
    name: str
    status: str
    detail: str

    def render(self) -> str:
        suffix = f" ({self.detail})" if self.detail else ""
        return f"{self.name}={self.status}{suffix}"


async def log_startup_connection_checks(settings: Settings) -> None:
    results = await collect_startup_connection_checks(settings)
    if not results:
        return

    rendered = " | ".join(item.render() for item in results)
    failing_statuses = {"failed", "config_missing"}
    level = logging.WARNING if any(item.status in failing_statuses for item in results) else logging.INFO
    logger.log(level, "Startup connectivity: %s", rendered)


async def collect_startup_connection_checks(settings: Settings) -> list[StartupCheckResult]:
    results = [
        _memory_postgres_result(settings),
        _checkpointer_postgres_result(settings),
        _tracing_postgres_result(settings),
    ]
    results.append(await _httpish_service_result("qdrant", settings.qdrant_enabled, settings.qdrant_simulate, settings.qdrant_base_url))
    results.append(
        await _httpish_service_result(
            "chatwoot",
            settings.chatwoot_reply_enabled,
            False,
            settings.chatwoot_api_base_url,
            require_config=bool(settings.chatwoot_api_token and settings.chatwoot_account_id),
            missing_detail="missing token/account_id",
        )
    )
    results.append(
        await _httpish_service_result(
            "llm",
            bool(settings.resolved_llm_base_url),
            False,
            settings.resolved_llm_base_url,
        )
    )
    return results


def _memory_postgres_result(settings: Settings) -> StartupCheckResult:
    if settings.memory_backend != "langgraph_postgres":
        return StartupCheckResult("postgres.memory", "disabled", f"backend={settings.memory_backend}")
    if not settings.memory_postgres_dsn:
        return StartupCheckResult("postgres.memory", "config_missing", "missing dsn")
    return StartupCheckResult("postgres.memory", "ok", _format_host_port(settings.memory_postgres_dsn))


def _checkpointer_postgres_result(settings: Settings) -> StartupCheckResult:
    dsn = settings.memory_postgres_dsn or settings.trace_postgres_dsn
    if not dsn:
        return StartupCheckResult("postgres.checkpoints", "disabled", "in_memory")
    return StartupCheckResult("postgres.checkpoints", "ok", _format_host_port(dsn))


def _tracing_postgres_result(settings: Settings) -> StartupCheckResult:
    if settings.trace_backend != "postgres":
        return StartupCheckResult("postgres.tracing", "disabled", f"backend={settings.trace_backend}")
    if not settings.trace_postgres_dsn:
        return StartupCheckResult("postgres.tracing", "config_missing", "missing dsn")
    detail = f"{_format_host_port(settings.trace_postgres_dsn)} schema={settings.trace_postgres_schema}"
    return StartupCheckResult("postgres.tracing", "ok", detail)


async def _httpish_service_result(
    name: str,
    enabled: bool,
    simulated: bool,
    url: str | None,
    *,
    require_config: bool = True,
    missing_detail: str = "missing url",
) -> StartupCheckResult:
    if simulated:
        return StartupCheckResult(name, "simulated", "")
    if not enabled:
        return StartupCheckResult(name, "disabled", "")
    if not url:
        return StartupCheckResult(name, "config_missing", missing_detail)
    if not require_config:
        return StartupCheckResult(name, "config_missing", missing_detail)

    host, port, ssl = _parse_network_target(url)
    detail = f"{host}:{port}"
    if ssl:
        detail += " ssl"
    try:
        await _probe_tcp_endpoint(host, port, ssl=ssl)
    except Exception as exc:
        return StartupCheckResult(name, "failed", f"{detail} {type(exc).__name__}")
    return StartupCheckResult(name, "ok", detail)


def _format_host_port(value: str) -> str:
    host, port, _ = _parse_network_target(value)
    return f"{host}:{port}"


def _parse_network_target(value: str) -> tuple[str, int, bool]:
    parsed = urlsplit(value)
    host = parsed.hostname or "unknown-host"
    if parsed.port is not None:
        return host, parsed.port, parsed.scheme in {"https", "wss"}
    if parsed.scheme in {"https", "wss"}:
        return host, 443, True
    return host, 80 if parsed.scheme in {"http", "ws"} else 5432, False


async def _probe_tcp_endpoint(host: str, port: int, *, ssl: bool, timeout_seconds: float = 1.5) -> None:
    reader = writer = None
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port, ssl=ssl),
            timeout=timeout_seconds,
        )
    finally:
        if writer is not None:
            writer.close()
            await writer.wait_closed()
