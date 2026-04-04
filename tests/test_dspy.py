import asyncio
from pathlib import Path

from app.dspy.dataset import DSPyDatasetExample, PostgresDSPyDatasetStore
from app.dspy.runtime import (
    _serialize_appointment_reply_payload,
    _serialize_conversation_reply_payload,
    _serialize_rag_reply_payload,
    build_dspy_runtime,
)
from app.models.schemas import RoutingPacket
from app.services.llm import GeneratedReply
from app.settings import Settings


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
