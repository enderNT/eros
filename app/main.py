from __future__ import annotations

from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse

from app.dspy import build_dspy_runtime
from app.graph.workflow import ClinicWorkflow
from app.observability.console_logging import configure_console_logging
from app.observability.flow_logger import configure_flow_logger
from app.observability.router_input_logger import configure_router_input_logger
from app.observability.startup_checks import collect_startup_connection_checks, log_startup_connection_checks
from app.services.agent import ClinicAgentService
from app.services.chatwoot import ChatwootClient
from app.services.checkpointer import build_graph_checkpointer
from app.services.clinic_config import ClinicConfigLoader
from app.services.llm import ClinicLLMService, build_llm_provider
from app.services.memory import build_memory_runtime
from app.services.router import StateRoutingService
from app.services.runtime_monitor import BackgroundTaskMonitor
from app.services.qdrant import QdrantRetrievalService
from app.services.tracing import build_trace_runtime
from app.settings import get_settings
from app.webhooks.routes import build_webhook_router


def create_app() -> FastAPI:
    settings = get_settings()
    log_level = getattr(logging, settings.log_level.upper(), logging.INFO)
    configure_console_logging(log_level)
    configure_flow_logger(log_level)
    configure_router_input_logger(settings.router_input_debug)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        clinic_config_loader = ClinicConfigLoader(settings.clinic_config_path)
        llm_provider = build_llm_provider(settings)
        llm_service = ClinicLLMService(llm_provider)
        dspy_runtime = build_dspy_runtime(settings)
        router_service = StateRoutingService(settings, llm_service, dspy_runtime=dspy_runtime)
        qdrant_service = QdrantRetrievalService(settings)
        async with build_graph_checkpointer(settings) as checkpointer:
            async with build_memory_runtime(settings, llm_service) as memory_runtime:
                async with build_trace_runtime(settings) as trace_runtime:
                    app.state.background_task_monitor = BackgroundTaskMonitor()
                    app.state.graph_checkpointer = checkpointer
                    workflow = ClinicWorkflow(
                        router_service,
                        llm_service,
                        memory_runtime,
                        clinic_config_loader,
                        qdrant_service,
                        settings,
                        dspy_runtime=dspy_runtime,
                        checkpointer=checkpointer,
                    )
                    app.state.agent_service = ClinicAgentService(
                        workflow,
                        ChatwootClient(settings),
                        trace_runtime,
                        settings,
                    )
                    await log_startup_connection_checks(settings, checkpointer=checkpointer)
                    yield

    app = FastAPI(title="Clinica Assistant", version="0.1.0", lifespan=lifespan)
    app.include_router(build_webhook_router())

    @app.get("/health")
    async def health(request: Request) -> JSONResponse:
        runtime_checks = await collect_startup_connection_checks(
            settings,
            checkpointer=getattr(request.app.state, "graph_checkpointer", None),
        )
        failing_statuses = {"failed", "config_missing"}
        dependency_healthy = not any(item.status in failing_statuses for item in runtime_checks)
        background_monitor = getattr(request.app.state, "background_task_monitor", None)
        background_snapshot = background_monitor.snapshot() if background_monitor is not None else {"status": "unknown"}
        overall_ok = dependency_healthy and background_snapshot.get("status") != "degraded"
        payload = {
            "status": "ok" if overall_ok else "degraded",
            "environment": settings.app_env,
            "checks": {item.name: {"status": item.status, "detail": item.detail} for item in runtime_checks},
            "background_processing": background_snapshot,
        }
        return JSONResponse(
            status_code=status.HTTP_200_OK if overall_ok else status.HTTP_503_SERVICE_UNAVAILABLE,
            content=payload,
        )

    return app
