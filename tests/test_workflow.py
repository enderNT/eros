import asyncio

from app.graph.workflow import ClinicWorkflow
from app.memory_runtime import ConversationMemoryRuntime, LLMConversationSummaryService
from app.models.schemas import AppointmentIntentPayload, ChatwootWebhook, StateRoutingDecision
from app.services.barbershop_memory import BarbershopMemoryPolicy
from app.services.clinic_config import ClinicConfigLoader
from app.services.router import StateRoutingService
from app.settings import Settings


class FakeLLMService:
    def __init__(self):
        self.summary_calls = 0
        self.conversation_contexts = []

    async def classify_state_route(self, routing_packet, guard_hint=None):
        del guard_hint
        message = routing_packet.user_message.lower()
        if "cita" in message or routing_packet.active_goal == "appointment":
            return StateRoutingDecision(
                next_node="appointment",
                intent="appointment",
                confidence=0.9,
                needs_retrieval=False,
                state_update={"active_goal": "appointment", "stage": "collecting_slots"},
                reason="test",
            )
        if "horario" in message or "precio" in message:
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
        del memories
        self.conversation_contexts.append(context)
        return f"Soy Eros Bot. Respuesta para: {user_message}"

    async def generate_conversation_reply(self, user_message, memories, context=None):
        from app.services.llm import GeneratedReply

        del memories
        self.conversation_contexts.append(context)
        return GeneratedReply(response_text=f"Soy Eros Bot. Respuesta para: {user_message}", reply_mode="llm")

    async def build_rag_reply(self, user_message, memories, clinic_context, context=None):
        del memories, clinic_context, context
        return f"RAG Eros Bot para: {user_message}"

    async def generate_rag_reply(self, user_message, memories, clinic_context, context=None):
        del memories, clinic_context, context
        from app.services.llm import GeneratedReply

        return GeneratedReply(response_text=f"RAG Eros Bot para: {user_message}", reply_mode="llm")

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
        del memories, clinic_context, contact_name, pending_question, context
        current_slots = current_slots or {}
        payload = AppointmentIntentPayload(
            patient_name=current_slots.get("patient_name", "Juan Perez"),
            reason=current_slots.get("reason", "psicoterapia"),
            preferred_date="manana" if "manana" in user_message.lower() else current_slots.get("preferred_date"),
            preferred_time="10 am" if "10" in user_message else current_slots.get("preferred_time"),
            missing_fields=[] if ("manana" in user_message.lower() and "10" in user_message) else ["preferred_time"],
            should_handoff=True,
            confidence=0.9,
        )
        return payload, f"Solicitud lista: {user_message} https://calendly.com/gayagocr/new-meeting"

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
        payload, _ = await self.extract_appointment_intent(
            user_message,
            memories,
            clinic_context,
            contact_name,
            current_slots=current_slots,
            pending_question=pending_question,
            context=context,
        )
        return payload

    async def generate_appointment_reply(self, appointment, user_message, memories, contact_name, context=None):
        del appointment, memories, contact_name, context
        from app.services.llm import GeneratedReply

        return GeneratedReply(
            response_text=f"Solicitud lista: {user_message} https://calendly.com/gayagocr/new-meeting",
            reply_mode="llm",
        )

    async def build_state_summary(self, current_summary, user_message, assistant_message, active_goal, stage):
        self.summary_calls += 1
        return f"{current_summary} | {active_goal}:{stage} | {user_message} -> {assistant_message}".strip(" |")


class FakeMemoryStore:
    def __init__(self):
        self.saved = []

    async def search(self, actor_id, query, limit=5):
        del actor_id, query, limit
        from app.memory_runtime.types import LongTermMemoryRecord

        return [
            LongTermMemoryRecord(kind="episode", text="Recuerdo util"),
            LongTermMemoryRecord(kind="profile", text="Prefiere horario vespertino"),
        ]

    async def save(self, actor_id, records):
        self.saved.append((actor_id, [record.model_dump() for record in records]))


class FakeQdrantService:
    def __init__(self):
        self.calls = 0

    async def build_context(self, *args, **kwargs):
        self.calls += 1
        del args, kwargs
        return "Contexto RAG simulado"


class FakeDSPyRuntime:
    def __init__(self):
        self.calls = []

    async def generate_conversation_reply(self, payload, llm_service, *, context=None):
        del llm_service, context
        self.calls.append(("conversation", payload))
        from app.services.llm import GeneratedReply

        return GeneratedReply(response_text=f"DSPy conversation: {payload['user_message']}", reply_mode="llm")

    async def generate_rag_reply(self, payload, llm_service, *, context=None):
        del llm_service, context
        self.calls.append(("rag", payload))
        from app.services.llm import GeneratedReply

        return GeneratedReply(response_text=f"DSPy rag: {payload['retrieved_context']}", reply_mode="llm")

    async def generate_appointment_reply(self, payload, llm_service, *, appointment, context=None):
        del llm_service, appointment, context
        self.calls.append(("appointment", payload))
        from app.services.llm import GeneratedReply

        return GeneratedReply(response_text=f"DSPy appointment: {payload['booking_url']}", reply_mode="llm")


def build_webhook(message: str, conversation_id: int = 123) -> ChatwootWebhook:
    return ChatwootWebhook(
        content=message,
        conversation={"id": conversation_id},
        contact={"id": 456, "name": "Juan Perez"},
        event="message_created",
        message_type="incoming",
    )


def build_workflow(dspy_runtime=None):
    llm = FakeLLMService()
    settings = Settings(llm_api_key=None, openai_api_key=None, memory_backend="in_memory")
    router = StateRoutingService(settings, llm)
    memory = FakeMemoryStore()
    memory_runtime = ConversationMemoryRuntime(
        store=memory,
        summary_service=LLMConversationSummaryService(llm),
        policy=BarbershopMemoryPolicy(),
    )
    qdrant = FakeQdrantService()
    workflow = ClinicWorkflow(
        router,
        llm,
        memory_runtime,
        ClinicConfigLoader(config_path="config/clinic.json"),  # type: ignore[arg-type]
        qdrant,
        settings,
        dspy_runtime=dspy_runtime,
    )
    return workflow, memory, qdrant, llm


def test_workflow_routes_to_conversation():
    workflow, memory, qdrant, llm = build_workflow()

    result = asyncio.run(workflow.run(build_webhook("Necesito informacion general sobre la clinica")))

    assert result["next_node"] == "conversation"
    assert result["response_text"] == "Soy Eros Bot. Respuesta para: Necesito informacion general sobre la clinica"
    assert result["handoff_required"] is False
    assert qdrant.calls == 0
    assert memory.saved
    assert llm.summary_calls >= 1


def test_workflow_routes_to_rag():
    workflow, memory, qdrant, _ = build_workflow()

    result = asyncio.run(workflow.run(build_webhook("Cuales son sus horarios?")))

    assert result["next_node"] == "rag"
    assert result["response_text"] == "RAG Eros Bot para: Cuales son sus horarios?"
    assert result["handoff_required"] is False
    assert qdrant.calls == 1
    assert memory.saved


def test_workflow_keeps_appointment_state_across_turns():
    workflow, memory, qdrant, llm = build_workflow()
    conversation_id = 777

    first = asyncio.run(workflow.run(build_webhook("Quiero una cita", conversation_id=conversation_id)))
    second = asyncio.run(workflow.run(build_webhook("manana a las 10", conversation_id=conversation_id)))

    assert first["next_node"] == "appointment"
    assert first["stage"] == "collecting_slots"
    assert second["next_node"] == "appointment"
    assert second["stage"] == "ready_for_handoff"
    assert second["appointment_slots"]["preferred_time"] == "10 am"
    assert "https://calendly.com/gayagocr/new-meeting" in second["response_text"]
    assert qdrant.calls == 0
    assert memory.saved
    assert llm.summary_calls >= 1


def test_workflow_passes_recent_context_to_conversation_reply():
    workflow, _, _, llm = build_workflow()
    conversation_id = 909

    asyncio.run(workflow.run(build_webhook("Hola", conversation_id=conversation_id)))
    asyncio.run(workflow.run(build_webhook("y que sigue?", conversation_id=conversation_id)))

    second_context = llm.conversation_contexts[-1]
    assert second_context is not None
    assert second_context.last_assistant_message == "Soy Eros Bot. Respuesta para: Hola"
    assert second_context.recent_turns[-1]["user"] == "Hola"
    assert second_context.recent_turns[-1]["assistant"] == "Soy Eros Bot. Respuesta para: Hola"


def test_workflow_strips_repeated_bot_intro_after_first_turn():
    workflow, _, _, _ = build_workflow()
    conversation_id = 910

    asyncio.run(workflow.run(build_webhook("Hola", conversation_id=conversation_id)))
    second = asyncio.run(workflow.run(build_webhook("y que sigue?", conversation_id=conversation_id)))

    assert not second["response_text"].lower().startswith("hola")
    assert not second["response_text"].lower().startswith("soy eros bot")
    assert second["response_text"] == "Respuesta para: y que sigue?"


def test_workflow_uses_dspy_runtime_for_reply_generation():
    dspy_runtime = FakeDSPyRuntime()
    workflow, _, qdrant, llm = build_workflow(dspy_runtime=dspy_runtime)

    conversation_result = asyncio.run(workflow.run(build_webhook("Hola DSPy", conversation_id=1111)))
    rag_result = asyncio.run(workflow.run(build_webhook("Cuales son sus horarios?", conversation_id=1112)))
    appointment_result = asyncio.run(workflow.run(build_webhook("Quiero una cita", conversation_id=1113)))

    assert conversation_result["response_text"] == "DSPy conversation: Hola DSPy"
    assert rag_result["response_text"] == "DSPy rag: Contexto RAG simulado"
    assert appointment_result["response_text"].startswith("DSPy appointment: https://calendly.com/gayagocr/new-meeting")
    assert [call[0] for call in dspy_runtime.calls] == ["conversation", "rag", "appointment"]
    assert qdrant.calls == 1
    assert llm.conversation_contexts == []
