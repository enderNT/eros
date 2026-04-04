import asyncio
from contextlib import asynccontextmanager

from app.graph.workflow import ClinicWorkflow
from app.memory_runtime import ConversationMemoryRuntime, LLMConversationSummaryService
from app.models.schemas import AppointmentIntentPayload, ChatwootWebhook, StateRoutingDecision
from app.services.barbershop_memory import BarbershopMemoryPolicy
from app.services.clinic_config import ClinicConfigLoader
from app.services.router import StateRoutingService
from app.services.tracing import (
    AppointmentReplyProjector,
    ConversationReplyProjector,
    RagReplyProjector,
    RoutingDecisionProjector,
    build_trace_runtime,
)
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
from app.tracing.repository import PostgresTraceRepository


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

    async def build_conversation_reply(self, user_message, memories, context=None):
        del memories, context
        return f"Respuesta: {user_message}"

    async def generate_conversation_reply(self, user_message, memories, context=None):
        del memories, context
        from app.services.llm import GeneratedReply

        return GeneratedReply(response_text=f"Respuesta: {user_message}", reply_mode="llm")

    async def build_rag_reply(self, user_message, memories, clinic_context, context=None):
        del memories, clinic_context, context
        return f"RAG: {user_message}"

    async def generate_rag_reply(self, user_message, memories, clinic_context, context=None):
        del memories, clinic_context, context
        from app.services.llm import GeneratedReply

        return GeneratedReply(response_text=f"RAG: {user_message}", reply_mode="llm")

    async def extract_appointment_intent(
        self,
        user_message,
        memories,
        clinic_context,
        contact_name,
        current_slots=None,
        pending_question=None,
        context=None,
    ):
        del user_message, memories, clinic_context, contact_name, current_slots, pending_question, context
        return AppointmentIntentPayload(), "ok"

    async def extract_appointment_payload(
        self,
        user_message,
        memories,
        clinic_context,
        contact_name,
        current_slots=None,
        pending_question=None,
        context=None,
    ):
        del user_message, memories, clinic_context, contact_name, current_slots, pending_question, context
        return AppointmentIntentPayload()

    async def generate_appointment_reply(self, appointment, user_message, memories, contact_name, context=None):
        del appointment, user_message, memories, contact_name, context
        from app.services.llm import GeneratedReply

        return GeneratedReply(response_text="ok", reply_mode="llm")

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
    context.capture_fragment(
        "routing_input",
        {
            "routing_packet": {
                "user_message": "Necesito una cita",
                "conversation_summary": "",
                "active_goal": "",
                "stage": "",
                "pending_action": "",
                "pending_question": "",
                "appointment_slots": {},
                "last_tool_result": "",
                "last_user_message": "Necesito una cita",
                "last_assistant_message": "",
                "memories": ["Prefiere tarde"],
            },
            "guard_hint": None,
            "secret": "top-secret",
        },
        order=1,
    )
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
    assert [fragment["order"] for fragment in repository.fragments["trace-success"]] == [1, 2, 5]
    assert [fragment["kind"] for fragment in repository.fragments["trace-success"]] == [
        "routing_input",
        "memory_lookup",
        "routing_decision",
    ]
    example = repository.examples[("trace-success", "state_router", "v2")]
    assert example.target_payload["next_node"] == "appointment"
    assert example.input_payload["user_message"] == "Necesito una cita"


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


async def test_postgres_trace_repository_skips_fragments_for_deduped_records():
    record = _build_record(trace_id="trace-duplicate", dedupe_key="dedupe-stable")
    executed_sql: list[str] = []

    class FakeCursor:
        def __init__(self):
            self._fetchone_value = None
            self._fetchall_value = []

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def execute(self, sql, params=None):
            del params
            normalized = " ".join(sql.split())
            executed_sql.append(normalized)
            if 'SELECT trace_id FROM "tracing"."trace_turns" WHERE dedupe_key' in normalized:
                self._fetchone_value = ("trace-existing",)
            elif 'SELECT trace_id FROM "tracing"."trace_turns" WHERE trace_id = ANY' in normalized:
                self._fetchall_value = []
            else:
                self._fetchone_value = None

        async def fetchone(self):
            return self._fetchone_value

        async def fetchall(self):
            return self._fetchall_value

    class FakeConnection:
        def cursor(self):
            return FakeCursor()

        async def commit(self):
            return None

    repository = PostgresTraceRepository("postgres://unused")

    @asynccontextmanager
    async def fake_connection():
        yield FakeConnection()

    repository._connection = fake_connection  # type: ignore[method-assign]

    await repository.save_batch([record], [])

    assert any('SELECT trace_id FROM "tracing"."trace_turns" WHERE dedupe_key' in sql for sql in executed_sql)
    assert not any('INSERT INTO "tracing"."trace_fragments"' in sql for sql in executed_sql)


async def test_postgres_trace_repository_setup_uses_schema_and_example_index():
    executed_sql: list[str] = []

    class FakeCursor:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def execute(self, sql, params=None):
            del params
            executed_sql.append(" ".join(str(sql).split()))

    class FakeConnection:
        def cursor(self):
            return FakeCursor()

        async def commit(self):
            return None

    repository = PostgresTraceRepository("postgres://unused", schema="analytics")

    @asynccontextmanager
    async def fake_connection():
        yield FakeConnection()

    repository._connection = fake_connection  # type: ignore[method-assign]

    await repository.setup()

    assert any('CREATE SCHEMA IF NOT EXISTS "analytics"' in sql for sql in executed_sql)
    assert any('"analytics"."trace_examples"(task_name, projector_version, created_at DESC)' in sql for sql in executed_sql)


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


async def test_trace_projectors_emit_reply_examples_when_fragments_exist():
    repository = InMemoryTraceRepository()
    sink = await AsyncBatchTraceSink(
        repository,
        projectors=[
            ConversationReplyProjector(),
            RagReplyProjector(),
            AppointmentReplyProjector(),
        ],
        batch_size=1,
        flush_interval_seconds=10,
    ).start()

    context = TraceContext(PassThroughTraceNormalizer()).start(
        TraceEnvelope(
            trace_id="trace-multitask",
            session_key="session-1",
            actor_key="actor-1",
            app_key="test-app",
            flow_key="flow-1",
            dedupe_key="trace-multitask",
            component_version="tests",
            model_backend="fake",
            model_name="fake-model",
        )
    )
    context.capture_input({"message": "Necesito horarios", "contact_name": "Juan"})
    context.capture_fragment(
        "appointment_reply_input",
        {
            "user_message": "Quiero una cita",
            "contact_name": "Juan",
            "summary": "Resumen breve",
            "active_goal": "appointment",
            "stage": "collecting_slots",
            "pending_question": "Necesito la hora preferida.",
            "last_assistant_message": "Claro",
            "recent_turns": [{"user": "Hola", "assistant": "Claro"}],
            "memories": ["Prefiere la tarde"],
            "appointment_state": {"reason": "psicoterapia", "missing_fields": ["preferred_time"]},
            "booking_url": "https://calendly.com/gayagocr/new-meeting",
        },
        order=1,
        label="appointment",
    )
    context.capture_fragment(
        "appointment_reply_output",
        {"response_text": "Te ayudo a completar tu cita", "reply_mode": "llm"},
        order=2,
        label="appointment",
    )
    context.capture_fragment(
        "conversation_reply_input",
        {
            "user_message": "Necesito horarios",
            "summary": "Resumen",
            "active_goal": "conversation",
            "stage": "open",
            "pending_question": "",
            "last_assistant_message": "Hola",
            "recent_turns": [{"user": "Hola", "assistant": "Hola"}],
            "memories": ["Prefiere la tarde"],
        },
        order=3,
        label="conversation",
    )
    context.capture_fragment(
        "conversation_reply_output",
        {"response_text": "Seguimos con tu consulta", "reply_mode": "fallback"},
        order=4,
        label="conversation",
    )
    context.capture_fragment(
        "rag_reply_input",
        {
            "user_message": "Necesito horarios",
            "summary": "Resumen",
            "active_goal": "information",
            "stage": "lookup",
            "pending_question": "",
            "last_assistant_message": "Hola",
            "recent_turns": [{"user": "Hola", "assistant": "Hola"}],
            "memories": ["Prefiere la tarde"],
            "retrieved_context": "Horarios de la clinica",
        },
        order=5,
        label="rag",
    )
    context.capture_fragment(
        "rag_reply_output",
        {"response_text": "Nuestros horarios son...", "reply_mode": "llm"},
        order=6,
        label="rag",
    )
    context.capture_output({"response_text": "Nuestros horarios son..."})

    await sink.enqueue(context.finalize("success"))
    await sink.close()

    assert repository.examples[("trace-multitask", "appointment_reply", "v1")].input_payload["appointment_state"]["reason"] == "psicoterapia"
    assert repository.examples[("trace-multitask", "conversation_reply", "v2")].metadata_payload["reply_mode"] == "fallback"
    assert repository.examples[("trace-multitask", "rag_reply", "v2")].input_payload["retrieved_context"] == "Horarios de la clinica"


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
    assert "routing_input" in fragment_kinds
    assert "routing_decision" in fragment_kinds
    assert "retrieval_context" in fragment_kinds
    assert "rag_reply_input" in fragment_kinds
    assert "rag_reply_output" in fragment_kinds


async def test_build_trace_runtime_registers_only_reply_projectors():
    settings = Settings(trace_backend="in_memory", trace_projectors_enabled=True)

    async with build_trace_runtime(settings) as runtime:
        projectors = runtime.sink._projectors

    assert [projector.name for projector in projectors] == [
        "conversation_reply",
        "rag_reply",
        "appointment_reply",
    ]
