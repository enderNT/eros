from __future__ import annotations

import argparse
import hashlib
import json
import os
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import dspy
from dspy.teleprompt import LabeledFewShot

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
            "active_goal",
            "stage",
            "pending_action",
            "pending_question",
            "appointment_slots",
            "last_tool_result",
            "last_user_message",
            "last_assistant_message",
            "memories",
            "guard_hint",
        ),
        "output_fields": (
            "next_node",
            "intent",
            "confidence",
            "needs_retrieval",
            "state_update",
            "reason",
        ),
        "complex_fields": {"appointment_slots", "memories", "guard_hint", "state_update"},
    },
}


TEXT_REPLY_TASKS = {"conversation_reply", "rag_reply"}


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


def _build_example(row: dict[str, Any], config: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dspy.Example]:
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


def _relative_to_repo(path: Path) -> str:
    repo_root = Path(__file__).resolve().parent.parent
    try:
        return str(path.resolve().relative_to(repo_root))
    except ValueError:
        return str(path)


def optimize_task(task_name: str, *, k: int = 16) -> None:
    if task_name not in TASK_CONFIGS:
        raise ValueError(f"Tarea no soportada: {task_name}")

    load_env_file()
    settings = RuntimeSettings.from_env()
    if not settings.api_key:
        raise RuntimeError("No se encontro DSPY_API_KEY ni OPENAI_API_KEY en el entorno o en .env.")

    qualified_model = settings.model if "/" in settings.model else f"openai/{settings.model}"
    dspy.configure(
        lm=dspy.LM(
            model=qualified_model,
            api_key=settings.api_key,
            api_base=settings.api_base or None,
        )
    )

    config = TASK_CONFIGS[task_name]
    dataset_path = _resolve_dataset_path(settings, config["dataset"])
    if not dataset_path.exists():
        raise FileNotFoundError(f"No se encontro el dataset para {task_name}: {dataset_path}")

    rows = _load_rows(dataset_path)
    train_rows, eval_rows, split_rule = _split_rows(rows)
    module_factory = MODULE_FACTORIES[task_name]

    trainset: list[dspy.Example] = []
    for row in train_rows:
        _, _, _, example = _build_example(row, config)
        trainset.append(example)

    baseline_module = module_factory()
    optimizer = LabeledFewShot(k=min(k, len(trainset)))
    compiled_module = optimizer.compile(module_factory(), trainset=trainset, sample=False)

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
        "optimizer": "dspy.LabeledFewShot",
        "validation_split": {
            "train_examples": len(train_rows),
            "eval_examples": len(eval_rows),
            "rule": split_rule,
        },
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
    print(f"[*] Artefacto: {artifact_path}")
    print(f"[*] Meta: {meta_path}")
    print(f"[*] Eval: {eval_path}")
    if baseline_scores and optimized_scores:
        print(f"[*] Score baseline: {evaluation_report['baseline_score']}")
        print(f"[*] Score optimizado: {evaluation_report['optimized_score']}")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Optimiza tareas DSPy con LabeledFewShot.")
    parser.add_argument("task", choices=sorted(TASK_CONFIGS))
    parser.add_argument("--k", type=int, default=16, help="Cantidad maxima de demos etiquetadas.")
    args = parser.parse_args(argv)
    optimize_task(args.task, k=args.k)


if __name__ == "__main__":
    main()