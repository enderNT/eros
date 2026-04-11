from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.dspy.modules import AppointmentReplyModule, ConversationReplyModule, RagReplyModule, StateRouterModule
from app.dspy.runtime import (
    _coerce_text,
    _build_dspy_lm,
    _prediction_to_dict,
    _serialize_appointment_reply_payload,
    _serialize_conversation_reply_payload,
    _serialize_rag_reply_payload,
    _serialize_state_router_payload,
)
from app.settings import Settings

try:
    import dspy
except ImportError as exc:  # pragma: no cover - script entrypoint
    raise SystemExit("DSPy is required to optimize a task. Install project dependencies first.") from exc


TASKS: dict[str, tuple[type[Any], Any]] = {
    "state_router": (StateRouterModule, _serialize_state_router_payload),
    "conversation_reply": (ConversationReplyModule, _serialize_conversation_reply_payload),
    "rag_reply": (RagReplyModule, _serialize_rag_reply_payload),
    "appointment_reply": (AppointmentReplyModule, _serialize_appointment_reply_payload),
}


def _load_examples(dataset_path: Path) -> list[dict[str, Any]]:
    raw = dataset_path.read_text(encoding="utf-8")
    decoder = json.JSONDecoder()
    rows: list[dict[str, Any]] = []
    cursor = 0

    while cursor < len(raw):
        while cursor < len(raw) and raw[cursor].isspace():
            cursor += 1
        if cursor >= len(raw):
            break
        try:
            value, cursor = decoder.raw_decode(raw, cursor)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSON document in {dataset_path} near character {exc.pos}.") from exc
        if not isinstance(value, dict):
            raise ValueError(f"Expected JSON objects in {dataset_path}, got {type(value).__name__}.")
        rows.append(value)

    if not rows:
        raise ValueError(f"Dataset {dataset_path} does not contain any JSON examples.")
    return rows


def _validate_examples(task_name: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    valid_rows: list[dict[str, Any]] = []

    for index, row in enumerate(rows, start=1):
        if row.get("task_name") != task_name:
            raise ValueError(
                f"Dataset row {index} is for task {row.get('task_name')!r}, expected only {task_name!r} rows."
            )

        input_payload = row.get("input_payload")
        if not isinstance(input_payload, dict) or not input_payload:
            raise ValueError(f"Dataset row {index} must include a non-empty object in input_payload.")

        target_payload = row.get("target_payload")
        if not isinstance(target_payload, dict):
            raise ValueError(f"Dataset row {index} must include an object in target_payload.")

        if task_name == "state_router":
            user_message = _coerce_text(input_payload.get("user_message"))
            if not user_message:
                raise ValueError(f"Dataset row {index} must include input_payload.user_message.")

            next_node = _coerce_text(target_payload.get("next_node"))
            intent = _coerce_text(target_payload.get("intent"))
            if not next_node:
                raise ValueError(f"Dataset row {index} must include target_payload.next_node.")
            if not intent:
                raise ValueError(f"Dataset row {index} must include target_payload.intent.")
            if "needs_retrieval" not in target_payload:
                raise ValueError(f"Dataset row {index} must include target_payload.needs_retrieval.")
            if "state_update" not in target_payload:
                raise ValueError(f"Dataset row {index} must include target_payload.state_update.")
            if "confidence" not in target_payload:
                raise ValueError(f"Dataset row {index} must include target_payload.confidence.")
            if target_payload.get("confidence") in (None, ""):
                raise ValueError(f"Dataset row {index} must include a non-empty target_payload.confidence.")

        if task_name == "conversation_reply":
            response_text = _coerce_text(target_payload.get("response_text"))
            if not response_text:
                raise ValueError(f"Dataset row {index} must include target_payload.response_text.")

        valid_rows.append(row)

    return valid_rows


def _dataset_fingerprint(rows: list[dict[str, Any]]) -> str:
    canonical = json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _deterministic_sort_key(row: dict[str, Any]) -> tuple[str, str]:
    trace_id = _coerce_text(row.get("trace_id"))
    canonical = json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return trace_id, hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _split_examples(task_name: str, rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if task_name not in {"conversation_reply", "state_router"}:
        return rows, []

    if len(rows) < 2:
        raise ValueError(f"{task_name} optimization requires at least 2 valid examples for train/eval.")

    ordered = sorted(rows, key=_deterministic_sort_key)
    eval_size = 1 if len(ordered) <= 5 else max(1, int(len(ordered) * 0.2))
    eval_size = min(eval_size, len(ordered) - 1)
    train_size = len(ordered) - eval_size
    return ordered[:train_size], ordered[train_size:]


def _build_trainset(task_name: str, rows: list[dict[str, Any]]) -> list[Any]:
    _, serializer = TASKS[task_name]
    trainset: list[Any] = []
    for row in rows:
        inputs = serializer(dict(row.get("input_payload") or {}))
        outputs = dict(row.get("target_payload") or {})
        example = dspy.Example(**inputs, **outputs)
        trainset.append(example.with_inputs(*inputs.keys()))
    return trainset


def _compile_module(task_name: str, trainset: list[Any]) -> Any:
    module_cls, _ = TASKS[task_name]
    module = module_cls()
    optimizer = getattr(dspy, "LabeledFewShot", None)
    if optimizer is None or not trainset:
        return module
    return optimizer(k=min(8, len(trainset))).compile(module, trainset=trainset)


def _predict_response(module: Any, payload: dict[str, Any]) -> dict[str, Any]:
    prediction = module.forward(**payload)
    return _prediction_to_dict(prediction)


def _evaluate_conversation_reply(
    eval_rows: list[dict[str, Any]],
    baseline_module: Any,
    optimized_module: Any,
) -> list[dict[str, Any]]:
    report_rows: list[dict[str, Any]] = []

    for row in eval_rows:
        serialized_input = _serialize_conversation_reply_payload(dict(row["input_payload"]))
        baseline_output = _predict_response(baseline_module, serialized_input)
        optimized_output = _predict_response(optimized_module, serialized_input)
        report_rows.append(
            {
                "trace_id": row.get("trace_id"),
                "input_payload": row["input_payload"],
                "serialized_input": serialized_input,
                "target_response_text": _coerce_text(row["target_payload"].get("response_text")),
                "baseline_response_text": _coerce_text(baseline_output.get("response_text")),
                "optimized_response_text": _coerce_text(optimized_output.get("response_text")),
            }
        )

    return report_rows


def _evaluate_state_router(
    eval_rows: list[dict[str, Any]],
    baseline_module: Any,
    optimized_module: Any,
) -> list[dict[str, Any]]:
    report_rows: list[dict[str, Any]] = []

    for row in eval_rows:
        serialized_input = _serialize_state_router_payload(dict(row["input_payload"]))
        baseline_output = _predict_response(baseline_module, serialized_input)
        optimized_output = _predict_response(optimized_module, serialized_input)
        report_rows.append(
            {
                "trace_id": row.get("trace_id"),
                "input_payload": row["input_payload"],
                "serialized_input": serialized_input,
                "target_payload": row["target_payload"],
                "baseline_output": {
                    "next_node": baseline_output.get("next_node"),
                    "intent": baseline_output.get("intent"),
                    "confidence": baseline_output.get("confidence"),
                    "needs_retrieval": baseline_output.get("needs_retrieval"),
                    "state_update": baseline_output.get("state_update"),
                    "reason": baseline_output.get("reason"),
                },
                "optimized_output": {
                    "next_node": optimized_output.get("next_node"),
                    "intent": optimized_output.get("intent"),
                    "confidence": optimized_output.get("confidence"),
                    "needs_retrieval": optimized_output.get("needs_retrieval"),
                    "state_update": optimized_output.get("state_update"),
                    "reason": optimized_output.get("reason"),
                },
            }
        )

    return report_rows


def _save_artifact(module: Any, artifact_path: Path) -> None:
    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    save = getattr(module, "save", None)
    if not callable(save):
        raise RuntimeError("The compiled DSPy module does not support save().")
    save(str(artifact_path))


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _configure_dspy() -> Settings:
    settings = Settings()
    dspy.configure(lm=_build_dspy_lm(settings))
    return settings


def _run_conversation_reply_flow(dataset_path: Path, artifact_path: Path) -> dict[str, Any]:
    rows = _validate_examples("conversation_reply", _load_examples(dataset_path))
    train_rows, eval_rows = _split_examples("conversation_reply", rows)
    trainset = _build_trainset("conversation_reply", train_rows)
    candidate_module = _compile_module("conversation_reply", trainset)
    baseline_module = ConversationReplyModule()

    report_path = artifact_path.with_suffix(".eval.json")
    report_payload = {
        "task": "conversation_reply",
        "dataset": str(dataset_path),
        "dataset_fingerprint": _dataset_fingerprint(rows),
        "valid_examples": len(rows),
        "train_examples": len(train_rows),
        "eval_examples": len(eval_rows),
        "review_required": True,
        "examples": _evaluate_conversation_reply(eval_rows, baseline_module, candidate_module),
    }
    _write_json(report_path, report_payload)

    final_module = _compile_module("conversation_reply", _build_trainset("conversation_reply", rows))
    _save_artifact(final_module, artifact_path)

    metadata_path = artifact_path.with_suffix(".meta.json")
    metadata_payload = {
        "task": "conversation_reply",
        "dataset": str(dataset_path),
        "examples": len(rows),
        "dataset_fingerprint": _dataset_fingerprint(rows),
        "compiled_at": datetime.now(timezone.utc).isoformat(),
        "optimizer": "dspy.LabeledFewShot",
        "validation_split": {
            "train_examples": len(train_rows),
            "eval_examples": len(eval_rows),
            "rule": "4/1 holdout when dataset size is 5 or less; otherwise deterministic 80/20 with at least 1 eval row",
        },
        "artifact_path": str(artifact_path),
        "evaluation_report_path": str(report_path),
    }
    _write_json(metadata_path, metadata_payload)

    return {
        "task": "conversation_reply",
        "dataset": str(dataset_path),
        "valid_examples": len(rows),
        "train_examples": len(train_rows),
        "eval_examples": len(eval_rows),
        "artifact": str(artifact_path),
        "evaluation_report": str(report_path),
        "metadata": str(metadata_path),
    }


def _run_state_router_flow(dataset_path: Path, artifact_path: Path) -> dict[str, Any]:
    rows = _validate_examples("state_router", _load_examples(dataset_path))
    train_rows, eval_rows = _split_examples("state_router", rows)
    trainset = _build_trainset("state_router", train_rows)
    candidate_module = _compile_module("state_router", trainset)
    baseline_module = StateRouterModule()

    report_path = artifact_path.with_suffix(".eval.json")
    report_payload = {
        "task": "state_router",
        "dataset": str(dataset_path),
        "dataset_fingerprint": _dataset_fingerprint(rows),
        "valid_examples": len(rows),
        "train_examples": len(train_rows),
        "eval_examples": len(eval_rows),
        "review_required": True,
        "examples": _evaluate_state_router(eval_rows, baseline_module, candidate_module),
    }
    _write_json(report_path, report_payload)

    final_module = _compile_module("state_router", _build_trainset("state_router", rows))
    _save_artifact(final_module, artifact_path)

    metadata_path = artifact_path.with_suffix(".meta.json")
    metadata_payload = {
        "task": "state_router",
        "dataset": str(dataset_path),
        "examples": len(rows),
        "dataset_fingerprint": _dataset_fingerprint(rows),
        "compiled_at": datetime.now(timezone.utc).isoformat(),
        "optimizer": "dspy.LabeledFewShot",
        "validation_split": {
            "train_examples": len(train_rows),
            "eval_examples": len(eval_rows),
            "rule": "deterministic 80/20 with at least 1 eval row; for datasets of size 5 or less, 4/1 holdout",
        },
        "artifact_path": str(artifact_path),
        "evaluation_report_path": str(report_path),
    }
    _write_json(metadata_path, metadata_payload)

    return {
        "task": "state_router",
        "dataset": str(dataset_path),
        "valid_examples": len(rows),
        "train_examples": len(train_rows),
        "eval_examples": len(eval_rows),
        "artifact": str(artifact_path),
        "evaluation_report": str(report_path),
        "metadata": str(metadata_path),
    }


def _run_generic_flow(task_name: str, dataset_path: Path, artifact_path: Path) -> dict[str, Any]:
    rows = _load_examples(dataset_path)
    trainset = _build_trainset(task_name, rows)
    module = _compile_module(task_name, trainset)
    _save_artifact(module, artifact_path)
    return {
        "task": task_name,
        "dataset": str(dataset_path),
        "examples": len(trainset),
        "artifact": str(artifact_path),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Compile a DSPy module from a task-specific JSONL dataset.")
    parser.add_argument("--task", required=True, choices=sorted(TASKS.keys()))
    parser.add_argument("--dataset", required=True, help="Path to the task JSONL dataset.")
    parser.add_argument("--artifact-out", required=True, help="Where to persist the compiled DSPy artifact.")
    args = parser.parse_args()

    _configure_dspy()

    dataset_path = Path(args.dataset)
    artifact_path = Path(args.artifact_out)
    if args.task == "conversation_reply":
        result = _run_conversation_reply_flow(dataset_path, artifact_path)
    elif args.task == "state_router":
        result = _run_state_router_flow(dataset_path, artifact_path)
    else:
        result = _run_generic_flow(args.task, dataset_path, artifact_path)

    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
