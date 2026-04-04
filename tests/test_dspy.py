from pathlib import Path

from app.dspy.dataset import DSPyDatasetExample, PostgresDSPyDatasetStore
from app.dspy.runtime import build_dspy_runtime
from app.models.schemas import RoutingPacket
from app.settings import Settings


class FakeExecutor:
    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    def predict_state_router(self, payload):
        self.calls.append(payload)
        return self.payload


async def test_dspy_runtime_coerces_router_payload_to_state_routing_decision():
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

    decision = await runtime.classify_state_route(
        RoutingPacket(
            user_message="Quiero agendar una cita",
            active_goal="conversation",
            stage="open",
        )
    )

    assert decision.next_node == "appointment"
    assert decision.state_update["stage"] == "collecting_slots"
    assert executor.calls[0]["guard_hint"] == "{}"


def test_dspy_dataset_store_normalizes_fragment_payloads():
    store = PostgresDSPyDatasetStore("postgres://unused")

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
                {"kind": "routing_decision", "label": "state-router", "order": 2, "payload": {"next_node": "conversation"}},
            ],
        )
    )

    assert isinstance(example, DSPyDatasetExample)
    assert example.fragment_payloads["routing_input"][0]["payload"]["user_message"] == "hola"
    assert example.fragment_payloads["routing_decision"][0]["order"] == 2


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
