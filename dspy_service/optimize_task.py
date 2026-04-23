from __future__ import annotations

import argparse
import hashlib
import json
import os
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from math import ceil
from typing import Any

import dspy
import litellm
from dspy.teleprompt import MIPROv2

try:
    from app import RuntimeSettings
    from modules import MODULE_FACTORIES
except ModuleNotFoundError:  # pragma: no cover - package-style fallback
    from .app import RuntimeSettings  # type: ignore
    from .modules import MODULE_FACTORIES  # type: ignore


TASK_CONFIGS: dict[str, dict[str, Any]] = {
    "conversation_reply": {
        "dataset": "conversation_reply.jsonl",
        "input_fields": (
            "user_message",
            "summary",
            "active_goal",
            "stage",
            "pending_question",
            "last_assistant_message",
            "recent_turns",
            "memories",
        ),
        "output_fields": ("response_text",),
        "complex_fields": {"recent_turns", "memories"},
    },
    "rag_reply": {
        "dataset": "rag_reply.jsonl",
        "input_fields": (
            "user_message",
            "summary",
            "active_goal",
            "stage",
            "pending_question",
            "last_assistant_message",
            "recent_turns",
            "memories",
            "retrieved_context",
        ),
        "output_fields": ("response_text",),
        "complex_fields": {"recent_turns", "memories"},
    },
    "state_router": {
        "dataset": "state_router.jsonl",
        "input_fields": (
            "user_message",
            "conversation_summary",
            "current_mode",
            "last_tool_result",
            "last_assistant_message",
            "memories",
        ),
        "output_fields": (
            "next_node",
            "intent",
            "confidence",
            "needs_retrieval",
            "state_update",
            "reason",
        ),
        "complex_fields": {"memories", "state_update"},
    },
}


TEXT_REPLY_TASKS = {"conversation_reply", "rag_reply"}

VALID_GPT5_REASONING_EFFORTS = {"minimal", "low", "medium", "high"}


def _is_gpt5_model(model_name: str) -> bool:
    normalized = model_name.lower().split("/", 1)[-1]
    return normalized.startswith("gpt-5")


def _resolve_gpt5_reasoning_effort() -> str:
    configured = os.getenv("DSPY_REASONING_EFFORT", "").strip().lower()
    if configured in VALID_GPT5_REASONING_EFFORTS:
        return configured
    return "minimal"


def _build_lm_kwargs(settings: RuntimeSettings) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "model": settings.model if "/" in settings.model else f"openai/{settings.model}",
        "api_key": settings.api_key,
        "api_base": settings.api_base or None,
    }

    if _is_gpt5_model(settings.model):
        kwargs["temperature"] = 1.0
        kwargs["reasoning_effort"] = _resolve_gpt5_reasoning_effort()

    return kwargs


def _build_mipro_kwargs(settings: RuntimeSettings, auto: str, num_threads: int | None) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "auto": auto,
        "num_threads": num_threads,
    }
    if _is_gpt5_model(settings.model):
        kwargs["init_temperature"] = 1.0
    return kwargs


def load_env_file() -> None:
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if not env_path.exists():
        return

    with open(env_path, "r", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if key and key not in os.environ:
                os.environ[key] = value.strip().strip("'\"")


def _to_prediction_dict(prediction: Any) -> dict[str, Any]:
    if isinstance(prediction, dict):
        return dict(prediction)
    if hasattr(prediction, "toDict"):
        return dict(prediction.toDict())
    if hasattr(prediction, "items"):
        return dict(prediction.items())
    return {
        key: getattr(prediction, key)
        for key in dir(prediction)
        if not key.startswith("_") and not callable(getattr(prediction, key))
    }


def _json_dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _serialize_value(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return _json_dump(value)
    return value


def _coerce_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "1", "yes"}:
            return True
        if lowered in {"false", "0", "no", ""}:
            return False
    return bool(value)


def _coerce_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _coerce_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _normalize_for_metric(task_name: str, payload: dict[str, Any]) -> dict[str, Any]:
    if task_name in TEXT_REPLY_TASKS:
        return {
            "response_text": str(payload.get("response_text", "")).strip(),
        }

    return {
        "next_node": str(payload.get("next_node", "")).strip(),
        "intent": str(payload.get("intent", "")).strip(),
        "confidence": _coerce_float(payload.get("confidence")),
        "needs_retrieval": _coerce_bool(payload.get("needs_retrieval")),
        "state_update": _coerce_object(payload.get("state_update")),
        "reason": str(payload.get("reason", "")).strip(),
    }


def _score_prediction(task_name: str, expected: dict[str, Any], actual: dict[str, Any]) -> float:
    normalized_expected = _normalize_for_metric(task_name, expected)
    normalized_actual = _normalize_for_metric(task_name, actual)

    if task_name in TEXT_REPLY_TASKS:
        return 1.0 if normalized_expected["response_text"] == normalized_actual["response_text"] else 0.0

    checks = [
        normalized_expected["next_node"] == normalized_actual["next_node"],
        normalized_expected["intent"] == normalized_actual["intent"],
        normalized_expected["needs_retrieval"] == normalized_actual["needs_retrieval"],
        normalized_expected["state_update"] == normalized_actual["state_update"],
        normalized_expected["reason"] == normalized_actual["reason"],
    ]

    expected_confidence = normalized_expected["confidence"]
    actual_confidence = normalized_actual["confidence"]
    if expected_confidence is None or actual_confidence is None:
        checks.append(expected_confidence == actual_confidence)
    else:
        checks.append(abs(expected_confidence - actual_confidence) <= 0.05)

    return sum(1.0 for result in checks if result) / len(checks)


def _build_metric(task_name: str, output_fields: tuple[str, ...]):
    def metric(example: dspy.Example, prediction: Any, trace: Any | None = None) -> float:
        del trace
        expected = {field: getattr(example, field) for field in output_fields}
        actual = _to_prediction_dict(prediction)
        return _score_prediction(task_name, expected, actual)

    return metric


def _dataset_fingerprint(dataset_path: Path) -> str:
    return hashlib.sha256(dataset_path.read_bytes()).hexdigest()


def _resolve_dataset_path(settings: RuntimeSettings, dataset_name: str) -> Path:
    dataset_path = settings.datasets_dir / dataset_name
    if dataset_path.exists():
        return dataset_path

    fallback_path = Path(__file__).resolve().parent / "datasets" / dataset_name
    if fallback_path.exists():
        return fallback_path

    return dataset_path


def _resolve_artifacts_dir(settings: RuntimeSettings) -> Path:
    if settings.artifacts_dir.exists():
        return settings.artifacts_dir
    return Path(__file__).resolve().parent / "artifacts"


def _load_rows(dataset_path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with open(dataset_path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def _split_rows(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str]:
    total = len(rows)
    if total < 2:
        raise ValueError("Se requieren al menos 2 ejemplos para optimizar y evaluar.")

    if total <= 5:
        return rows[:-1], rows[-1:], "4/1 holdout when dataset size is 5 or less; otherwise deterministic 80/20 with at least 1 eval row"

    train_count = min(total - 1, max(1, round(total * 0.8)))
    return rows[:train_count], rows[train_count:], "4/1 holdout when dataset size is 5 or less; otherwise deterministic 80/20 with at least 1 eval row"


def _split_train_for_mipro(
    train_rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    total = len(train_rows)
    if total <= 1:
        return train_rows, train_rows, {
            "train_examples": total,
            "val_examples": total,
            "rule": "trainset too small; reused train rows as valset for MIPROv2",
        }

    if total <= 4:
        mipro_train_count = max(1, total - 1)
        rule = "tiny-train split with last row reserved as valset for MIPROv2"
    else:
        mipro_train_count = max(1, total - ceil(total * 0.5))
        rule = "deterministic 50/50 split of train rows into MIPRO train/val for MIPROv2"

    if mipro_train_count >= total:
        mipro_train_count = total - 1

    mipro_train_rows = train_rows[:mipro_train_count]
    mipro_val_rows = train_rows[mipro_train_count:]
    return mipro_train_rows, mipro_val_rows, {
        "train_examples": len(mipro_train_rows),
        "val_examples": len(mipro_val_rows),
        "rule": rule,
    }


def _build_example(row: dict[str, Any], config: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dspy.Example]:
    row = _normalize_row(row, config)
    input_payload: dict[str, Any] = {}
    serialized_input: dict[str, Any] = {}
    output_payload: dict[str, Any] = {}

    complex_fields = set(config["complex_fields"])
    for field in config["input_fields"]:
        value = deepcopy(row.get(field, [] if field in {"recent_turns", "memories"} else {} if field in {"appointment_slots", "guard_hint"} else ""))
        input_payload[field] = value
        serialized_input[field] = _serialize_value(value) if field in complex_fields else ("" if value is None else value)

    for field in config["output_fields"]:
        value = deepcopy(row.get(field, ""))
        output_payload[field] = value

    example_kwargs = {**serialized_input, **{field: _serialize_value(output_payload[field]) for field in config["output_fields"]}}
    example = dspy.Example(**example_kwargs).with_inputs(*config["input_fields"])
    return input_payload, serialized_input, output_payload, example


def _normalize_row(row: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    normalized = deepcopy(row)
    if "current_mode" in config["input_fields"] and not normalized.get("current_mode"):
        active_goal = str(normalized.get("active_goal", "")).strip().lower()
        stage = str(normalized.get("stage", "")).strip().lower()
        last_tool_result = str(normalized.get("last_tool_result", "")).strip()
        if active_goal == "appointment" or stage in {"collecting_slots", "ready_for_handoff"}:
            normalized["current_mode"] = "appointment"
        elif active_goal == "information" or stage == "lookup" or last_tool_result:
            normalized["current_mode"] = "information"
        else:
            normalized["current_mode"] = "conversation"
    return normalized


def _relative_to_repo(path: Path) -> str:
    repo_root = Path(__file__).resolve().parent.parent
    try:
        return str(path.resolve().relative_to(repo_root))
    except ValueError:
        return str(path)


def optimize_task(
    task_name: str,
    *,
    auto: str = "light",
    max_bootstrapped_demos: int = 4,
    max_labeled_demos: int = 4,
    num_threads: int | None = None,
) -> None:
    if task_name not in TASK_CONFIGS:
        raise ValueError(f"Tarea no soportada: {task_name}")

    load_env_file()
    settings = RuntimeSettings.from_env()
    if not settings.api_key:
        raise RuntimeError("No se encontro DSPY_API_KEY ni OPENAI_API_KEY en el entorno o en .env.")

    litellm.drop_params = True
    dspy.configure(
        lm=dspy.LM(**_build_lm_kwargs(settings))
    )

    config = TASK_CONFIGS[task_name]
    dataset_path = _resolve_dataset_path(settings, config["dataset"])
    if not dataset_path.exists():
        raise FileNotFoundError(f"No se encontro el dataset para {task_name}: {dataset_path}")

    rows = _load_rows(dataset_path)
    train_rows, eval_rows, split_rule = _split_rows(rows)
    mipro_train_rows, mipro_val_rows, mipro_split = _split_train_for_mipro(train_rows)
    module_factory = MODULE_FACTORIES[task_name]

    trainset: list[dspy.Example] = []
    for row in mipro_train_rows:
        _, _, _, example = _build_example(row, config)
        trainset.append(example)

    valset: list[dspy.Example] = []
    for row in mipro_val_rows:
        _, _, _, example = _build_example(row, config)
        valset.append(example)

    baseline_module = module_factory()
    metric = _build_metric(task_name, config["output_fields"])
    optimizer = MIPROv2(
        metric=metric,
        max_bootstrapped_demos=min(max_bootstrapped_demos, len(trainset)),
        max_labeled_demos=min(max_labeled_demos, len(trainset)),
        **_build_mipro_kwargs(settings, auto, num_threads),
    )
    compiled_module = optimizer.compile(
        module_factory(),
        trainset=trainset,
        valset=valset,
    )

    eval_examples: list[dict[str, Any]] = []
    baseline_scores: list[float] = []
    optimized_scores: list[float] = []

    for row in eval_rows:
        input_payload, serialized_input, output_payload, _ = _build_example(row, config)
        baseline_prediction = _to_prediction_dict(baseline_module.forward(**serialized_input))
        optimized_prediction = _to_prediction_dict(compiled_module.forward(**serialized_input))
        baseline_scores.append(_score_prediction(task_name, output_payload, baseline_prediction))
        optimized_scores.append(_score_prediction(task_name, output_payload, optimized_prediction))

        if task_name in TEXT_REPLY_TASKS:
            eval_examples.append(
                {
                    "trace_id": str(row.get("trace_id", "")),
                    "input_payload": input_payload,
                    "serialized_input": serialized_input,
                    "target_response_text": str(output_payload.get("response_text", "")),
                    "baseline_response_text": str(baseline_prediction.get("response_text", "")),
                    "optimized_response_text": str(optimized_prediction.get("response_text", "")),
                }
            )
        else:
            eval_examples.append(
                {
                    "trace_id": str(row.get("trace_id", "")),
                    "input_payload": input_payload,
                    "serialized_input": serialized_input,
                    "target_payload": output_payload,
                    "baseline_output": baseline_prediction,
                    "optimized_output": optimized_prediction,
                }
            )

    artifacts_dir = _resolve_artifacts_dir(settings)
    artifacts_dir.mkdir(exist_ok=True)
    artifact_path = artifacts_dir / f"{task_name}.json"
    meta_path = artifacts_dir / f"{task_name}.meta.json"
    eval_path = artifacts_dir / f"{task_name}.eval.json"

    compiled_module.save(str(artifact_path))

    compiled_at = datetime.now(timezone.utc).isoformat()
    dataset_fingerprint = _dataset_fingerprint(dataset_path)

    meta = {
        "task": task_name,
        "dataset": _relative_to_repo(dataset_path),
        "examples": len(rows),
        "dataset_fingerprint": dataset_fingerprint,
        "compiled_at": compiled_at,
        "optimizer": "dspy.MIPROv2",
        "optimizer_settings": {
            "auto": auto,
            "max_bootstrapped_demos": min(max_bootstrapped_demos, len(trainset)),
            "max_labeled_demos": min(max_labeled_demos, len(trainset)),
            "num_threads": num_threads,
            "mipro_train_examples": len(trainset),
            "mipro_val_examples": len(valset),
        },
        "validation_split": {
            "train_examples": len(train_rows),
            "eval_examples": len(eval_rows),
            "rule": split_rule,
        },
        "optimizer_split": mipro_split,
        "artifact_path": _relative_to_repo(artifact_path),
        "evaluation_report_path": _relative_to_repo(eval_path),
    }

    evaluation_report = {
        "task": task_name,
        "dataset": _relative_to_repo(dataset_path),
        "dataset_fingerprint": dataset_fingerprint,
        "valid_examples": len(rows),
        "train_examples": len(train_rows),
        "eval_examples": len(eval_rows),
        "baseline_score": round(sum(baseline_scores) / len(baseline_scores), 4) if baseline_scores else None,
        "optimized_score": round(sum(optimized_scores) / len(optimized_scores), 4) if optimized_scores else None,
        "review_required": True,
        "examples": eval_examples,
    }

    with open(meta_path, "w", encoding="utf-8") as handle:
        json.dump(meta, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    with open(eval_path, "w", encoding="utf-8") as handle:
        json.dump(evaluation_report, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    print(f"[*] Tarea: {task_name}")
    print(f"[*] Modelo: {settings.model}")
    print(f"[*] Dataset: {dataset_path} ({len(rows)} ejemplos)")
    print(f"[*] Train/Eval: {len(train_rows)}/{len(eval_rows)}")
    print(f"[*] MIPRO train/val: {len(trainset)}/{len(valset)}")
    print(f"[*] Artefacto: {artifact_path}")
    print(f"[*] Meta: {meta_path}")
    print(f"[*] Eval: {eval_path}")
    if baseline_scores and optimized_scores:
        print(f"[*] Score baseline: {evaluation_report['baseline_score']}")
        print(f"[*] Score optimizado: {evaluation_report['optimized_score']}")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Optimiza tareas DSPy con MIPROv2.")
    parser.add_argument("task", choices=sorted(TASK_CONFIGS))
    parser.add_argument(
        "--auto",
        choices=("light", "medium", "heavy"),
        default="light",
        help="Preset de exploracion para MIPROv2.",
    )
    parser.add_argument(
        "--max-bootstrapped-demos",
        type=int,
        default=4,
        help="Cantidad maxima de demos bootstrap usadas por MIPROv2.",
    )
    parser.add_argument(
        "--max-labeled-demos",
        type=int,
        default=4,
        help="Cantidad maxima de demos etiquetadas usadas por MIPROv2.",
    )
    parser.add_argument(
        "--num-threads",
        type=int,
        default=None,
        help="Cantidad de hilos para evaluacion paralela dentro de MIPROv2.",
    )
    args = parser.parse_args(argv)
    optimize_task(
        args.task,
        auto=args.auto,
        max_bootstrapped_demos=args.max_bootstrapped_demos,
        max_labeled_demos=args.max_labeled_demos,
        num_threads=args.num_threads,
    )


if __name__ == "__main__":
    main()
