from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException

try:
    import dspy  # type: ignore
except Exception:  # pragma: no cover - optional dependency bootstrap
    dspy = None

try:
    import litellm
except Exception:  # pragma: no cover - optional dependency bootstrap
    litellm = None

try:
    from modules import MODULE_FACTORIES
    from service_logging import DspyExecutionLogger, DspyOperationalLogger
except ModuleNotFoundError:  # pragma: no cover - package-style fallback
    from .modules import MODULE_FACTORIES  # type: ignore
    from .service_logging import DspyExecutionLogger, DspyOperationalLogger  # type: ignore


TASK_OUTPUT_FIELDS: dict[str, list[str]] = {
    "state_router": ["next_node", "intent", "confidence", "needs_retrieval", "state_update", "reason"],
    "conversation_reply": ["reply_reasoning", "response_text"],
    "rag_reply": ["response_text"],
    "appointment_reply": ["response_text"],
}

VALID_GPT5_REASONING_EFFORTS = {"minimal", "low", "medium", "high"}


def _load_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _prediction_to_dict(prediction: Any) -> dict[str, Any]:
    if isinstance(prediction, dict):
        return dict(prediction)
    if hasattr(prediction, "toDict"):
        return dict(prediction.toDict())
    if hasattr(prediction, "items"):
        return dict(prediction.items())
    return {
        "next_node": getattr(prediction, "next_node", "conversation"),
        "intent": getattr(prediction, "intent", "conversation"),
        "confidence": getattr(prediction, "confidence", 0.0),
        "needs_retrieval": getattr(prediction, "needs_retrieval", False),
        "state_update": getattr(prediction, "state_update", {}),
        "reason": getattr(prediction, "reason", ""),
        "response_text": getattr(prediction, "response_text", ""),
    }


def _has_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    return True


logging_enabled = os.getenv("DSPY_LOG_TO_CONSOLE", "true").strip().lower() != "false"
SERVICE_LOGGER = DspyOperationalLogger(console_enabled=logging_enabled)

app = FastAPI(title="eros-dspy-runtime", version="0.3.0")


def _is_gpt5_model(model_name: str) -> bool:
    normalized = model_name.lower().split("/", 1)[-1]
    return normalized.startswith("gpt-5")


def _resolve_gpt5_reasoning_effort() -> str:
    configured = os.getenv("DSPY_REASONING_EFFORT", "").strip().lower()
    if configured in VALID_GPT5_REASONING_EFFORTS:
        return configured
    return "minimal"


def _build_lm_kwargs(settings: "RuntimeSettings") -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "model": settings.model if "/" in settings.model else f"openai/{settings.model}",
        "api_base": settings.api_base,
        "api_key": settings.api_key,
    }
    if _is_gpt5_model(settings.model):
        kwargs["temperature"] = 1.0
        kwargs["reasoning_effort"] = _resolve_gpt5_reasoning_effort()
    return kwargs


@dataclass(slots=True)
class RuntimeSettings:
    api_base: str
    api_key: str
    model: str
    artifacts_dir: Path
    datasets_dir: Path

    @classmethod
    def from_env(cls) -> "RuntimeSettings":
        base_dir = Path(__file__).resolve().parent
        artifacts_dir = os.getenv("DSPY_ARTIFACTS_DIR", "").strip()
        datasets_dir = os.getenv("DSPY_DATASETS_DIR", "").strip()
        return cls(
            api_base=os.getenv("DSPY_API_BASE", "").strip(),
            api_key=os.getenv("DSPY_API_KEY", "").strip(),
            model=os.getenv("DSPY_MODEL", "gpt-4o-mini").strip(),
            artifacts_dir=(Path(artifacts_dir) if artifacts_dir else (base_dir / "artifacts")).resolve(),
            datasets_dir=(Path(datasets_dir) if datasets_dir else (base_dir / "datasets")).resolve(),
        )


@dataclass(slots=True)
class TaskPredictor:
    task_name: str
    module: Any | None
    mode: str
    artifact_path: Path
    meta: dict[str, Any]
    load_error: str | None = None

    @property
    def available(self) -> bool:
        return self.mode == "artifact" and self.module is not None

    def predict(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.available:
            raise RuntimeError(f"No artifact-backed predictor available for task {self.task_name}.")
        prediction = self.module.forward(**payload)
        return _prediction_to_dict(prediction)

    def status_payload(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "available": self.available,
            "artifact_present": self.artifact_path.exists(),
            "artifact_loaded": self.available,
            "artifact_path": str(self.artifact_path),
            "load_error": self.load_error or "",
            "optimizer": self.meta.get("optimizer", ""),
            "compiled_at": self.meta.get("compiled_at", ""),
            "examples": self.meta.get("examples", 0),
            "dataset": self.meta.get("dataset", ""),
        }


class DSPyServiceRuntime:
    def __init__(self, settings: RuntimeSettings, logger: DspyOperationalLogger) -> None:
        self.settings = settings
        self.logger = logger
        self.backend = self._configure_dspy()
        self.predictors = {
            task_name: self._build_predictor(task_name)
            for task_name in TASK_OUTPUT_FIELDS
        }
        self.logger.log_startup(self.health_payload())

    @property
    def ready(self) -> bool:
        return self.backend == "dspy" and any(predictor.available for predictor in self.predictors.values())

    def predict(
        self,
        task_name: str,
        payload: dict[str, Any],
        run: DspyExecutionLogger,
    ) -> tuple[dict[str, Any] | None, str]:
        predictor = self.predictors.get(task_name)
        if self.backend != "dspy":
            run.load(f"backend={self.backend} predictor=disabled", is_error=True)
            return None, "backend_unavailable"

        if predictor is None:
            run.load(f"task={task_name} predictor=missing", is_error=True)
            return None, "task_missing"

        descriptor = f"backend=dspy mode={predictor.mode}"
        if predictor.artifact_path.exists():
            descriptor += f" artifact={predictor.artifact_path.name}"
        if predictor.load_error:
            descriptor += f" load_error={predictor.load_error}"
        run.load(descriptor, is_error=not predictor.available)

        if not predictor.available:
            return None, predictor.mode

        try:
            prediction = predictor.predict(payload)
        except Exception as exc:  # pragma: no cover - runtime fallback
            run.flow(f"{task_name} predict_failed mode={predictor.mode} error={exc}", is_error=True)
            return None, "predict_failed"

        outputs = {
            field: prediction.get(field)
            for field in TASK_OUTPUT_FIELDS[task_name]
        }
        available_outputs = [field for field, value in outputs.items() if _has_value(value)]
        if not available_outputs:
            run.flow(f"{task_name} artifact returned no usable outputs", is_error=True)
            return None, "empty_prediction"

        run.flow(f"{task_name} mode={predictor.mode} outputs={','.join(available_outputs)}")
        return outputs, "ok"

    def health_payload(self) -> dict[str, Any]:
        return {
            "ok": True,
            "ready": self.ready,
            "backend": self.backend,
            "dspy_available": bool(dspy),
            "model": self.settings.model,
            "api_base_configured": bool(self.settings.api_base),
            "api_key_configured": bool(self.settings.api_key),
            "artifacts_dir": str(self.settings.artifacts_dir),
            "datasets_dir": str(self.settings.datasets_dir),
            "tasks": {
                task_name: predictor.status_payload()
                for task_name, predictor in self.predictors.items()
            },
        }

    def _configure_dspy(self) -> str:
        if not dspy:
            return "missing_dependency"
        if not self.settings.api_base or not self.settings.api_key:
            return "unconfigured"

        try:
            if litellm is not None:
                litellm.drop_params = True
            dspy.configure(
                lm=dspy.LM(**_build_lm_kwargs(self.settings))
            )
            return "dspy"
        except Exception as exc:  # pragma: no cover - external runtime
            self.logger.log_system_error("configure", "dspy_runtime", exc)
            return "configure_failed"

    def _build_predictor(self, task_name: str) -> TaskPredictor:
        artifact_path = self.settings.artifacts_dir / f"{task_name}.json"
        meta_path = self.settings.artifacts_dir / f"{task_name}.meta.json"
        meta = _load_json(meta_path)

        if self.backend != "dspy":
            return TaskPredictor(
                task_name=task_name,
                module=None,
                mode="backend_unavailable",
                artifact_path=artifact_path,
                meta=meta,
            )

        module_factory = MODULE_FACTORIES.get(task_name)
        if module_factory is None:
            return TaskPredictor(
                task_name=task_name,
                module=None,
                mode="task_missing",
                artifact_path=artifact_path,
                meta=meta,
            )

        if not artifact_path.exists():
            return TaskPredictor(
                task_name=task_name,
                module=None,
                mode="no_artifact",
                artifact_path=artifact_path,
                meta=meta,
            )

        try:
            module = module_factory()
            load = getattr(module, "load", None)
            if not callable(load):
                return TaskPredictor(
                    task_name=task_name,
                    module=None,
                    mode="load_unsupported",
                    artifact_path=artifact_path,
                    meta=meta,
                    load_error="module_load_unsupported",
                )

            load(str(artifact_path))
            return TaskPredictor(
                task_name=task_name,
                module=module,
                mode="artifact",
                artifact_path=artifact_path,
                meta=meta,
            )
        except Exception as exc:  # pragma: no cover - runtime fallback
            return TaskPredictor(
                task_name=task_name,
                module=None,
                mode="load_failed",
                artifact_path=artifact_path,
                meta=meta,
                load_error=str(exc),
            )


def _predict_with_logging(task_name: str, payload: dict[str, Any]) -> tuple[dict[str, Any] | None, str, DspyExecutionLogger]:
    run = SERVICE_LOGGER.start_run(task_name, payload)
    run.open()
    prediction, status = RUNTIME.predict(task_name, payload, run)
    return prediction, status, run


def _passthrough_to_app(task_name: str, status: str, run: DspyExecutionLogger) -> None:
    run.out(f"task={task_name} passthrough=app_llm reason={status}", is_error=True)
    run.end("passthrough")
    raise HTTPException(
        status_code=409,
        detail={
            "task": task_name,
            "reason": status,
            "message": "No artifact-backed DSPy predictor available for this task.",
        },
    )


SETTINGS = RuntimeSettings.from_env()
RUNTIME = DSPyServiceRuntime(SETTINGS, SERVICE_LOGGER)


@app.get("/health")
def health() -> dict[str, Any]:
    return RUNTIME.health_payload()


@app.post("/predict/state-router")
def predict_state_router(payload: dict[str, Any]) -> dict[str, Any]:
    prediction, status, run = _predict_with_logging(
        "state_router",
        {
            "user_message": payload.get("user_message", ""),
            "conversation_summary": payload.get("conversation_summary", ""),
            "current_mode": payload.get("current_mode", "conversation"),
            "last_tool_result": payload.get("last_tool_result", ""),
            "last_assistant_message": payload.get("last_assistant_message", ""),
            "memories": payload.get("memories", []),
        },
    )
    if not prediction:
        _passthrough_to_app("state_router", status, run)

    next_node = str(prediction.get("next_node", "conversation"))
    run.out(f"reply_mode=artifact next_node={next_node}")
    run.end("ok")
    return prediction


@app.post("/predict/conversation-reply")
def predict_conversation_reply(payload: dict[str, Any]) -> dict[str, Any]:
    prediction, status, run = _predict_with_logging(
        "conversation_reply",
        {
            "user_message": payload.get("user_message", ""),
            "context_summary": payload.get("context_summary", payload.get("summary", "")),
            "last_assistant_message": payload.get("last_assistant_message", ""),
        },
    )
    if not prediction or not str(prediction.get("response_text", "")).strip():
        _passthrough_to_app("conversation_reply", status, run)

    response = {
        "reply_reasoning": str(prediction.get("reply_reasoning", "")).strip(),
        "response_text": str(prediction.get("response_text", "")).strip(),
        "reply_mode": "llm",
    }
    run.out(f"reply_mode=artifact text=\"{response['response_text'][:120]}\"")
    run.end("ok")
    return response


@app.post("/predict/rag-reply")
def predict_rag_reply(payload: dict[str, Any]) -> dict[str, Any]:
    prediction, status, run = _predict_with_logging(
        "rag_reply",
        {
            "user_message": payload.get("user_message", ""),
            "summary": payload.get("summary", ""),
            "active_goal": payload.get("active_goal", ""),
            "stage": payload.get("stage", ""),
            "pending_question": payload.get("pending_question", ""),
            "last_assistant_message": payload.get("last_assistant_message", ""),
            "recent_turns": payload.get("recent_turns", []),
            "memories": payload.get("memories", []),
            "retrieved_context": payload.get("retrieved_context", ""),
        },
    )
    if not prediction or not str(prediction.get("response_text", "")).strip():
        _passthrough_to_app("rag_reply", status, run)

    response = {
        "response_text": str(prediction.get("response_text", "")).strip(),
        "reply_mode": "llm",
    }
    run.out(f"reply_mode=artifact text=\"{response['response_text'][:120]}\"")
    run.end("ok")
    return response


@app.post("/predict/appointment-reply")
def predict_appointment_reply(payload: dict[str, Any]) -> dict[str, Any]:
    prediction, status, run = _predict_with_logging(
        "appointment_reply",
        {
            "user_message": payload.get("user_message", ""),
            "contact_name": payload.get("contact_name", ""),
            "summary": payload.get("summary", ""),
            "active_goal": payload.get("active_goal", ""),
            "stage": payload.get("stage", ""),
            "pending_question": payload.get("pending_question", ""),
            "last_assistant_message": payload.get("last_assistant_message", ""),
            "recent_turns": payload.get("recent_turns", []),
            "memories": payload.get("memories", []),
            "appointment_state": payload.get("appointment_state", {}),
            "booking_url": payload.get("booking_url", ""),
        },
    )
    if not prediction or not str(prediction.get("response_text", "")).strip():
        _passthrough_to_app("appointment_reply", status, run)

    response = {
        "response_text": str(prediction.get("response_text", "")).strip(),
        "reply_mode": "llm",
    }
    run.out(f"reply_mode=artifact text=\"{response['response_text'][:120]}\"")
    run.end("ok")
    return response
