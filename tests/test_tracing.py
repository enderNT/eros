import asyncio

from app.graph.workflow import ClinicWorkflow
from app.memory_runtime import ConversationMemoryRuntime, LLMConversationSummaryService
from app.models.schemas import AppointmentIntentPayload, ChatwootWebhook, StateRoutingDecision
from app.services.barbershop_memory import BarbershopMemoryPolicy
from app.services.clinic_config import ClinicConfigLoader
from app.services.router import StateRoutingService
from app.services.tracing import RoutingDecisionProjector
from app.settings import Settings
from app.tracing import (
    AsyncBatchTraceSink,
    InMemoryTraceRepository,
    PassThroughTraceNormalizer,
    ProjectedExample,
    TraceContext,
    TraceEnvelope,
    bind_trace_context,
    reset_trace_context,
)


class FakeLLMService:
    async def classify_state_route(self, routing_packet, guard_hint=None):
        del guard_hint
        if "horario" in routing_packet.user_message.lower():
            return StateRoutingDecision(
                next_node="rag",
                intent="rag",
                confidence=0.85,
                needs_retrieval=True,
                state_update={"active_goal": "information", "stage": "lookup"},
                reason="test",
            )
        return StateRoutingDecision(
            next_node="conversation",
            intent="conversation",
            confidence=0.8,
            needs_retrieval=False,
            state_update={"active_goal": "conversation", "stage": "open"},
            reason="test",
        )

    async def build_conversation_reply(self, user_message, memories):
        del memories
        return f"Respuesta: {user_message}"

    async def build_rag_reply(self, user_message, memories, clinic_context):
        del memories, clinic_context
        return f"RAG: {user_message}"

    async def extract_appointment_intent(
        self, user_message, memories, clinic_context, contact_name, current_slots=None, pending_question=None
    ):
        del user_message, memories, clinic_context, contact_name, current_slots, pending_question
        return AppointmentIntentPayload(), "ok"

    async def build_state_summary(self, current_summary, user_message, assistant_message, active_goal, stage):
        return f"{current_summary}|{user_message}|{assistant_message}|{active_goal}|{stage}".strip("|")


class FakeMemoryStore:
    async def search(self, actor_id, query, limit=5):
        del actor_id, query, limit
        from app.memory_runtime.types import LongTermMemoryRecord

        return [LongTermMemoryRecord(kind="episode", text="Recuerdo util")]

    async def save(self, actor_id, records):
        del actor_id, records


class FakeQdrantService:
    async def build_context(self, *args, **kwargs):
        del args, kwargs
        return "Contexto RAG simulado"


def build_webhook(message: str, conversation_id: int = 123) -> ChatwootWebhook:
    return ChatwootWebhook(
        content=message,
        conversation={"id": conversation_id},
        contact={"id": 456, "name": "Juan Perez"},
        event="message_created",
        message_type="incoming",
    )


def build_workflow():
    llm = FakeLLMService()
    settings = Settings(llm_api_key=None, openai_api_key=None, memory_backend="in_memory")
    router = StateRoutingService(settings, llm)
    memory_runtime = ConversationMemoryRuntime(
        store=FakeMemoryStore(),
        summary_service=LLMConversationSummaryService(llm),
        policy=BarbershopMemoryPolicy(),
    )
    return ClinicWorkflow(
        router,
        llm,
        memory_runtime,
        ClinicConfigLoader(config_path="config/clinic.json"),  # type: ignore[arg-type]
        FakeQdrantService(),
        settings,
    )


def _build_record(
    *,
    trace_id: str,
    dedupe_key: str | None,
    outcome: str = "success",
    include_output: bool = True,
    include_error: bool = False,
):
    context = TraceContext(PassThroughTraceNormalizer()).start(
        TraceEnvelope(
            trace_id=trace_id,
            session_key="session-1",
            actor_key="actor-1",
            app_key="test-app",
            flow_key="flow-1",
            dedupe_key=dedupe_key,
            component_version="tests",
            model_backend="fake",
            model_name="fake-model",
        )
    )
    context.capture_input({"message": "Necesito una cita", "secret": "top-secret"})
    context.capture_fragment("memory_lookup", {"recalled_memories": ["Prefiere tarde"], "secret": "top-secret"}, order=2)
    context.capture_fragment(
        "routing_decision",
        {"next_node": "appointment", "intent": "appointment", "needs_retrieval": False},
        order=5,
    )
    if include_output:
        context.capture_output({"response_text": "Claro, te ayudo", "secret": "top-secret"})
    if include_error:
        context.capture_error({"message": "fallo", "secret": "top-secret"})
    return context.finalize(outcome, tags={"channel": "chatwoot"})


async def test_trace_sink_persists_successful_turn_with_fragments_output_and_projection():
    repository = InMemoryTraceRepository()
    sink = await AsyncBatchTraceSink(
        repository,
        projectors=[RoutingDecisionProjector()],
        batch_size=1,
        flush_interval_seconds=10,
    ).start()

    record = _build_record(trace_id="trace-success", dedupe_key="dedupe-success")
    await sink.enqueue(record)
    await sink.close()

    stored = repository.turns["trace-success"]
    assert stored.outcome == "success"
    assert stored.output_payload["response_text"] == "Claro, te ayudo"
    assert [fragment["order"] for fragment in repository.fragments["trace-success"]] == [2, 5]
    assert [fragment["kind"] for fragment in repository.fragments["trace-success"]] == [
        "memory_lookup",
        "routing_decision",
    ]
    example = repository.examples[("trace-success", "state_router", "v1")]
    assert example.target_payload["next_node"] == "appointment"


async def test_trace_sink_persists_failed_turn_without_output():
    repository = InMemoryTraceRepository()
    sink = await AsyncBatchTraceSink(repository, batch_size=1, flush_interval_seconds=10).start()

    record = _build_record(
        trace_id="trace-error",
        dedupe_key="dedupe-error",
        outcome="error",
        include_output=False,
        include_error=True,
    )
    await sink.enqueue(record)
    await sink.close()

    stored = repository.turns["trace-error"]
    assert stored.outcome == "error"
    assert stored.output_payload == {}
    assert stored.error_payload["message"] == "fallo"


async def test_trace_sink_flushes_on_interval():
    repository = InMemoryTraceRepository()
    sink = await AsyncBatchTraceSink(repository, batch_size=10, flush_interval_seconds=0.05).start()

    await sink.enqueue(_build_record(trace_id="trace-interval", dedupe_key="dedupe-interval"))
    await asyncio.sleep(0.12)

    assert "trace-interval" in repository.turns
    await sink.close()


async def test_trace_sink_flushes_pending_records_on_shutdown():
    repository = InMemoryTraceRepository()
    sink = await AsyncBatchTraceSink(repository, batch_size=10, flush_interval_seconds=60).start()

    await sink.enqueue(_build_record(trace_id="trace-shutdown", dedupe_key="dedupe-shutdown"))
    await sink.close()

    assert "trace-shutdown" in repository.turns


async def test_trace_repository_respects_dedupe_and_projector_version_upserts():
    repository = InMemoryTraceRepository()
    record = _build_record(trace_id="trace-dedupe", dedupe_key="dedupe-stable")

    await repository.save_batch(
        [record],
        [
            ProjectedExample(
                trace_id="trace-dedupe",
                task_name="state_router",
                projector_version="v1",
                input_payload={"message": "hola"},
                target_payload={"next_node": "appointment"},
                metadata_payload={},
            )
        ],
    )
    await repository.save_batch([_build_record(trace_id="trace-duplicate", dedupe_key="dedupe-stable")], [])
    await repository.save_batch(
        [],
        [
            ProjectedExample(
                trace_id="trace-dedupe",
                task_name="state_router",
                projector_version="v2",
                input_payload={"message": "hola"},
                target_payload={"next_node": "appointment"},
                metadata_payload={"source": "new-version"},
            )
        ],
    )
    await repository.save_batch(
        [],
        [
            ProjectedExample(
                trace_id="trace-dedupe",
                task_name="state_router",
                projector_version="v2",
                input_payload={"message": "hola"},
                target_payload={"next_node": "rag"},
                metadata_payload={"source": "updated"},
            )
        ],
    )

    assert len(repository.turns) == 1
    assert len(repository.examples) == 2
    assert repository.examples[("trace-dedupe", "state_router", "v2")].target_payload["next_node"] == "rag"


async def test_trace_sink_applies_field_policy_before_persist_and_before_project():
    class StageAwarePolicy:
        def apply(self, payload, *, stage, section):
            if not isinstance(payload, dict):
                return payload
            sanitized = dict(payload)
            if "secret" in sanitized:
                sanitized["secret"] = f"{stage}:{section}"
            return sanitized

    class EchoProjector:
        name = "echo"
        version = "v1"

        def project(self, trace_record):
            return [
                ProjectedExample(
                    trace_id=trace_record.envelope.trace_id,
                    task_name="echo",
                    projector_version=self.version,
                    input_payload={"secret": trace_record.input_payload.get("secret")},
                    target_payload={"secret": trace_record.output_payload.get("secret")},
                    metadata_payload={"secret": trace_record.fragments[0].payload.get("secret")},
                )
            ]

    repository = InMemoryTraceRepository()
    sink = await AsyncBatchTraceSink(
        repository,
        projectors=[EchoProjector()],
        field_policy=StageAwarePolicy(),
        batch_size=1,
        flush_interval_seconds=10,
    ).start()

    await sink.enqueue(_build_record(trace_id="trace-policy", dedupe_key="dedupe-policy"))
    await sink.close()

    stored = repository.turns["trace-policy"]
    example = repository.examples[("trace-policy", "echo", "v1")]
    assert stored.input_payload["secret"] == "persist:input"
    assert stored.fragments[0].payload["secret"] == "persist:fragment"
    assert example.input_payload["secret"] == "project:input"
    assert example.target_payload["secret"] == "project:target"
    assert example.metadata_payload["secret"] == "project:metadata"


def test_workflow_emits_trace_fragments_when_context_is_bound():
    workflow = build_workflow()
    webhook = build_webhook("Cuales son sus horarios?", conversation_id=888)
    trace_context = TraceContext(PassThroughTraceNormalizer()).start(
        TraceEnvelope(
            trace_id="trace-workflow",
            session_key=webhook.conversation_id,
            actor_key=webhook.contact_id,
            app_key="test-app",
            flow_key="flow-workflow",
        )
    )
    trace_context.capture_input({"message": webhook.latest_message})
    token = bind_trace_context(trace_context)

    try:
        result = asyncio.run(workflow.run(webhook))
    finally:
        reset_trace_context(token)

    record = trace_context.current_record()
    fragment_kinds = [fragment.kind for fragment in record.fragments] if record else []
    assert result["next_node"] == "rag"
    assert "memory_lookup" in fragment_kinds
    assert "routing_decision" in fragment_kinds
    assert "retrieval_context" in fragment_kinds
    assert "llm_reply" in fragment_kinds
    assert "memory_commit" in fragment_kinds
