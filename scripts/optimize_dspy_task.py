from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from app.dspy.modules import AppointmentReplyModule, ConversationReplyModule, RagReplyModule
from app.dspy.runtime import (
    _serialize_appointment_reply_payload,
    _serialize_conversation_reply_payload,
    _serialize_rag_reply_payload,
)

try:
    import dspy
except ImportError as exc:  # pragma: no cover - script entrypoint
    raise SystemExit("DSPy is required to optimize a task. Install project dependencies first.") from exc


TASKS: dict[str, tuple[type[Any], Any]] = {
    "conversation_reply": (ConversationReplyModule, _serialize_conversation_reply_payload),
    "rag_reply": (RagReplyModule, _serialize_rag_reply_payload),
    "appointment_reply": (AppointmentReplyModule, _serialize_appointment_reply_payload),
}


def _load_examples(dataset_path: Path) -> list[dict[str, Any]]:
    examples: list[dict[str, Any]] = []
    for line in dataset_path.read_text(encoding="utf-8").splitlines():
        compact = line.strip()
        if compact:
            examples.append(json.loads(compact))
    return examples


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


def _save_artifact(module: Any, artifact_path: Path) -> None:
    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    save = getattr(module, "save", None)
    if not callable(save):
        raise RuntimeError("The compiled DSPy module does not support save().")
    save(str(artifact_path))


def main() -> int:
    parser = argparse.ArgumentParser(description="Compile a DSPy module from a task-specific JSONL dataset.")
    parser.add_argument("--task", required=True, choices=sorted(TASKS.keys()))
    parser.add_argument("--dataset", required=True, help="Path to the task JSONL dataset.")
    parser.add_argument("--artifact-out", required=True, help="Where to persist the compiled DSPy artifact.")
    args = parser.parse_args()

    dataset_path = Path(args.dataset)
    artifact_path = Path(args.artifact_out)
    rows = _load_examples(dataset_path)
    trainset = _build_trainset(args.task, rows)
    module = _compile_module(args.task, trainset)
    _save_artifact(module, artifact_path)
    print(
        json.dumps(
            {
                "task": args.task,
                "dataset": str(dataset_path),
                "examples": len(trainset),
                "artifact": str(artifact_path),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
