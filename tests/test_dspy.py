import asyncio
import json
from pathlib import Path

import pytest

from app.dspy.dataset import DSPyDatasetExample, PostgresDSPyDatasetStore
from app.dspy.runtime import NativeDSPyExecutor
from app.dspy.runtime import (
    _serialize_appointment_reply_payload,
    _serialize_conversation_reply_payload,
    _serialize_rag_reply_payload,
    build_dspy_runtime,
)
from app.models.schemas import RoutingPacket
from app.services.llm import GeneratedReply
from app.settings import Settings
from scripts import optimize_dspy_task


class FakeExecutor:
    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    def predict_state_router(self, payload):
        self.calls.append(("state_router", payload))
        return self.payload

    def predict_conversation_reply(self, payload):
        self.calls.append(("conversation_reply", payload))
        return self.payload

    def predict_rag_reply(self, payload):
        self.calls.append(("rag_reply", payload))
        return self.payload

    def predict_appointment_reply(self, payload):
        self.calls.append(("appointment_reply", payload))
        return self.payload


class FakeLLMService:
    def __init__(self):
        self.calls = []

    async def generate_conversation_reply(self, user_message, memories, context=None):
        self.calls.append(("conversation_reply", user_message, list(memories), context))
        return GeneratedReply(response_text=f"fallback conversation: {user_message}", reply_mode="fallback")

    async def generate_rag_reply(self, user_message, memories, clinic_context, context=None):
        self.calls.append(("rag_reply", user_message, list(memories), clinic_context, context))
        return GeneratedReply(response_text=f"fallback rag: {user_message}", reply_mode="fallback")

    async def generate_appointment_reply(self, appointment, user_message, memories, contact_name, context=None):
        self.calls.append(
            ("appointment_reply", appointment, user_message, list(memories), contact_name, context)
        )
        return GeneratedReply(response_text=f"fallback appointment: {user_message}", reply_mode="fallback")


def test_dspy_runtime_coerces_router_payload_to_state_routing_decision():
    executor = FakeExecutor(
        {
            "next_node": "appointment",
            "intent": "appointment",
            "confidence": "0.91",
            "needs_retrieval": "false",
            "state_update": '{"active_goal":"appointment","stage":"collecting_slots"}',
            "reason": "dspy-router",
        }
    )
    runtime = build_dspy_runtime(
        Settings(dspy_enabled=True, dspy_router_enabled=True, llm_api_key=None, openai_api_key=None),
        executor=executor,
    )

    decision = asyncio.run(
        runtime.classify_state_route(
            RoutingPacket(
                user_message="Quiero agendar una cita",
                active_goal="conversation",
                stage="open",
            )
        )
    )

    assert decision.next_node == "appointment"
    assert decision.state_update["stage"] == "collecting_slots"
    assert executor.calls[0][1]["guard_hint"] == "{}"


def test_conversation_reply_payload_serialization_is_stable():
    serialized = _serialize_conversation_reply_payload(
        {
            "user_message": "Hola",
            "summary": "Resumen",
            "active_goal": "conversation",
            "stage": "open",
            "pending_question": "",
            "last_assistant_message": "Hola anterior",
            "recent_turns": [{"assistant": "A", "user": "U"}],
            "memories": ["Recuerdo 1", "Recuerdo 2"],
        }
    )

    assert serialized["recent_turns"] == '[{"assistant": "A", "user": "U"}]'
    assert serialized["memories"] == '["Recuerdo 1", "Recuerdo 2"]'


def test_rag_reply_payload_serialization_keeps_full_context():
    serialized = _serialize_rag_reply_payload(
        {
            "user_message": "Horarios",
            "summary": "",
            "active_goal": "information",
            "stage": "lookup",
            "pending_question": "",
            "last_assistant_message": "",
            "recent_turns": [],
            "memories": [],
            "retrieved_context": "Horario completo\nLunes a viernes",
        }
    )

    assert serialized["retrieved_context"] == "Horario completo\nLunes a viernes"


def test_appointment_reply_payload_serialization_encodes_state_as_json():
    serialized = _serialize_appointment_reply_payload(
        {
            "user_message": "Quiero una cita",
            "contact_name": "Juan",
            "summary": "",
            "active_goal": "appointment",
            "stage": "collecting_slots",
            "pending_question": "Falta la hora",
            "last_assistant_message": "",
            "recent_turns": [],
            "memories": ["Prefiere tardes"],
            "appointment_state": {
                "preferred_time": None,
                "missing_fields": ["preferred_time"],
                "confidence": 0.8,
            },
            "booking_url": "https://example.com/book",
        }
    )

    assert serialized["appointment_state"] == (
        '{"confidence": 0.8, "missing_fields": ["preferred_time"], "preferred_time": null}'
    )


def test_dspy_runtime_uses_dspy_prediction_for_conversation_reply():
    executor = FakeExecutor({"response_text": "respuesta dspy"})
    runtime = build_dspy_runtime(Settings(dspy_enabled=True, llm_api_key=None, openai_api_key=None), executor=executor)
    llm_service = FakeLLMService()

    reply = asyncio.run(
        runtime.generate_conversation_reply(
            {
                "user_message": "Hola",
                "summary": "",
                "active_goal": "conversation",
                "stage": "open",
                "pending_question": "",
                "last_assistant_message": "",
                "recent_turns": [],
                "memories": ["Recuerdo"],
            },
            llm_service,
        )
    )

    assert reply.response_text == "respuesta dspy"
    assert reply.reply_mode == "llm"
    assert executor.calls[0][0] == "conversation_reply"
    assert llm_service.calls == []


def test_dspy_runtime_falls_back_when_reply_prediction_fails():
    class FailingExecutor(FakeExecutor):
        def predict_rag_reply(self, payload):
            self.calls.append(("rag_reply", payload))
            raise RuntimeError("artifact missing")

    executor = FailingExecutor({})
    runtime = build_dspy_runtime(Settings(dspy_enabled=True, llm_api_key=None, openai_api_key=None), executor=executor)
    llm_service = FakeLLMService()

    reply = asyncio.run(
        runtime.generate_rag_reply(
            {
                "user_message": "Horarios",
                "summary": "",
                "active_goal": "information",
                "stage": "lookup",
                "pending_question": "",
                "last_assistant_message": "",
                "recent_turns": [],
                "memories": ["Recuerdo"],
                "retrieved_context": "Lunes a viernes",
            },
            llm_service,
        )
    )

    assert reply.response_text == "fallback rag: Horarios"
    assert reply.reply_mode == "fallback"
    assert executor.calls[0][0] == "rag_reply"
    assert llm_service.calls[0][0] == "rag_reply"


def test_dspy_runtime_falls_back_when_disabled():
    runtime = build_dspy_runtime(Settings(dspy_enabled=False, llm_api_key=None, openai_api_key=None))
    llm_service = FakeLLMService()

    reply = asyncio.run(
        runtime.generate_appointment_reply(
            {
                "user_message": "Quiero una cita",
                "contact_name": "Juan",
                "summary": "",
                "active_goal": "appointment",
                "stage": "collecting_slots",
                "pending_question": "",
                "last_assistant_message": "",
                "recent_turns": [],
                "memories": [],
                "appointment_state": {"missing_fields": ["preferred_time"]},
                "booking_url": "https://example.com/book",
            },
            llm_service,
            appointment={"missing_fields": ["preferred_time"]},
        )
    )

    assert reply.response_text == "fallback appointment: Quiero una cita"
    assert reply.reply_mode == "fallback"


def test_settings_resolve_dspy_artifact_path_with_task_specific_override():
    settings = Settings(
        llm_api_key=None,
        openai_api_key=None,
        dspy_artifacts_dir=Path("artifacts/base"),
        dspy_rag_reply_artifact=Path("custom/rag.json"),
    )

    assert settings.resolve_dspy_artifact_path("conversation_reply") == Path("artifacts/base/conversation_reply.json")
    assert settings.resolve_dspy_artifact_path("rag_reply") == Path("custom/rag.json")


def test_dspy_dataset_store_normalizes_fragment_payloads():
    store = PostgresDSPyDatasetStore("postgres://unused", schema="analytics")

    example = store._normalize_row(
        (
            "trace-1",
            "state_router",
            "v2",
            {"user_message": "hola"},
            {"next_node": "conversation"},
            {"outcome": "success"},
            [
                {"kind": "routing_input", "label": "state-router", "order": 1, "payload": {"user_message": "hola"}},
                {
                    "kind": "routing_decision",
                    "label": "state-router",
                    "order": 2,
                    "payload": {"next_node": "conversation"},
                },
            ],
        )
    )

    assert isinstance(example, DSPyDatasetExample)
    assert example.fragment_payloads["routing_input"][0]["payload"]["user_message"] == "hola"
    assert example.fragment_payloads["routing_decision"][0]["order"] == 2


def test_dspy_dataset_store_qualifies_tables_with_schema():
    store = PostgresDSPyDatasetStore("postgres://unused", schema="analytics")

    assert store._qualified_table("trace_examples") == '"analytics"."trace_examples"'


def test_dspy_dataset_example_jsonl_serialization():
    example = DSPyDatasetExample(
        trace_id="trace-1",
        task_name="state_router",
        projector_version="v2",
        input_payload={"user_message": "hola"},
        target_payload={"next_node": "conversation"},
    )

    row = example.to_jsonl_row()

    assert '"task_name": "state_router"' in row
    assert '"next_node": "conversation"' in row


def test_optimize_script_loads_multiline_json_objects(tmp_path):
    dataset_path = tmp_path / "conversation_reply.jsonl"
    dataset_path.write_text(
        (
            json.dumps(
                {
                    "trace_id": "trace-1",
                    "task_name": "conversation_reply",
                    "input_payload": {"user_message": "Hola"},
                    "target_payload": {"response_text": "Hola"},
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n"
            + json.dumps(
                {
                    "trace_id": "trace-2",
                    "task_name": "conversation_reply",
                    "input_payload": {"user_message": "Precio"},
                    "target_payload": {"response_text": "Te ayudo con eso"},
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n"
        ),
        encoding="utf-8",
    )

    rows = optimize_dspy_task._load_examples(dataset_path)

    assert [row["trace_id"] for row in rows] == ["trace-1", "trace-2"]


def test_optimize_script_validates_conversation_reply_examples():
    valid_rows = optimize_dspy_task._validate_examples(
        "conversation_reply",
        [
            {
                "trace_id": "trace-1",
                "task_name": "conversation_reply",
                "input_payload": {"user_message": "Hola"},
                "target_payload": {"response_text": "Hola"},
            }
        ],
    )

    assert len(valid_rows) == 1

    with pytest.raises(ValueError, match="expected only 'conversation_reply' rows"):
        optimize_dspy_task._validate_examples(
            "conversation_reply",
            [
                {
                    "trace_id": "trace-2",
                    "task_name": "rag_reply",
                    "input_payload": {"user_message": "Hola"},
                    "target_payload": {"response_text": "Hola"},
                }
            ],
        )

    with pytest.raises(ValueError, match="target_payload.response_text"):
        optimize_dspy_task._validate_examples(
            "conversation_reply",
            [
                {
                    "trace_id": "trace-3",
                    "task_name": "conversation_reply",
                    "input_payload": {"user_message": "Hola"},
                    "target_payload": {},
                }
            ],
        )


def test_optimize_script_generates_conversation_reply_artifacts(tmp_path, monkeypatch):
    dataset_path = tmp_path / "conversation_reply.jsonl"
    dataset_rows = [
        {
            "trace_id": f"trace-{index}",
            "task_name": "conversation_reply",
            "input_payload": {
                "user_message": f"mensaje {index}",
                "summary": "",
                "active_goal": "conversation",
                "stage": "open",
                "pending_question": "",
                "last_assistant_message": "",
                "recent_turns": [],
                "memories": [],
            },
            "target_payload": {"response_text": f"objetivo {index}"},
        }
        for index in range(5)
    ]
    dataset_path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in dataset_rows) + "\n", encoding="utf-8")
    artifact_path = tmp_path / "artifacts" / "conversation_reply.json"

    class FakeExample(dict):
        def with_inputs(self, *keys):
            self["input_keys"] = keys
            return self

    class FakeModule:
        def __init__(self, mode="baseline"):
            self.mode = mode

        def forward(self, **kwargs):
            user_message = kwargs.get("user_message", "")
            return {"response_text": f"{self.mode}:{user_message}"}

        def save(self, path):
            Path(path).write_text(json.dumps({"mode": self.mode}), encoding="utf-8")

        def load(self, path):
            self.loaded_from = path

    class FakeOptimizer:
        def __init__(self, k):
            self.k = k

        def compile(self, module, *, trainset, sample=True):
            compiled = FakeModule(mode=f"optimized-{len(trainset)}")
            compiled.trainset = list(trainset)
            return compiled

    class FakeDSPy:
        Example = FakeExample
        LabeledFewShot = FakeOptimizer

    monkeypatch.setattr(optimize_dspy_task, "dspy", FakeDSPy)
    monkeypatch.setattr(optimize_dspy_task, "ConversationReplyModule", FakeModule)
    monkeypatch.setitem(
        optimize_dspy_task.TASKS,
        "conversation_reply",
        (FakeModule, lambda payload: dict(payload)),
    )

    result = optimize_dspy_task._run_conversation_reply_flow(dataset_path, artifact_path)

    assert result["train_examples"] == 4
    assert result["eval_examples"] == 1
    assert artifact_path.exists()
    assert artifact_path.with_suffix(".eval.json").exists()
    assert artifact_path.with_suffix(".meta.json").exists()

    report = json.loads(artifact_path.with_suffix(".eval.json").read_text(encoding="utf-8"))
    assert report["valid_examples"] == 5
    assert len(report["examples"]) == 1
    assert report["examples"][0]["baseline_response_text"].startswith("baseline:")
    assert report["examples"][0]["optimized_response_text"].startswith("optimized-4:")


def test_native_dspy_executor_uses_default_conversation_artifact_path():
    settings = Settings(llm_api_key=None, openai_api_key=None)

    assert settings.resolve_dspy_artifact_path("conversation_reply") == Path("artifacts/dspy/conversation_reply.json")


def test_native_dspy_executor_returns_none_when_artifact_load_fails(tmp_path):
    artifact_path = tmp_path / "broken.json"
    artifact_path.write_text("{}", encoding="utf-8")

    class BrokenModule:
        def load(self, path):
            raise RuntimeError(f"cannot load {path}")

    executor = NativeDSPyExecutor.__new__(NativeDSPyExecutor)

    loaded = executor._load_module(artifact_path, BrokenModule)

    assert loaded is None
