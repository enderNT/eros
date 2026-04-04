from __future__ import annotations

from typing import Any

try:
    import dspy
except ImportError:  # pragma: no cover - exercised through runtime fallback
    dspy = None  # type: ignore[assignment]


if dspy is not None:

    class StateRouterSignature(dspy.Signature):
        """Route the conversation state and emit structured JSON-compatible fields."""

        user_message = dspy.InputField()
        conversation_summary = dspy.InputField()
        active_goal = dspy.InputField()
        stage = dspy.InputField()
        pending_action = dspy.InputField()
        pending_question = dspy.InputField()
        appointment_slots = dspy.InputField()
        last_tool_result = dspy.InputField()
        last_user_message = dspy.InputField()
        last_assistant_message = dspy.InputField()
        memories = dspy.InputField()
        guard_hint = dspy.InputField()

        next_node = dspy.OutputField()
        intent = dspy.OutputField()
        confidence = dspy.OutputField()
        needs_retrieval = dspy.OutputField()
        state_update = dspy.OutputField()
        reason = dspy.OutputField()


    class AppointmentExtractionSignature(dspy.Signature):
        """Extract appointment slots from the current turn."""

        user_message = dspy.InputField()
        memories = dspy.InputField()
        clinic_context = dspy.InputField()
        contact_name = dspy.InputField()
        current_slots = dspy.InputField()
        pending_question = dspy.InputField()
        reply_context = dspy.InputField()

        patient_name = dspy.OutputField()
        reason = dspy.OutputField()
        preferred_date = dspy.OutputField()
        preferred_time = dspy.OutputField()
        missing_fields = dspy.OutputField()
        should_handoff = dspy.OutputField()
        confidence = dspy.OutputField()


    class ConversationReplySignature(dspy.Signature):
        """Draft a conversational assistant reply."""

        user_message = dspy.InputField()
        summary = dspy.InputField()
        active_goal = dspy.InputField()
        stage = dspy.InputField()
        pending_question = dspy.InputField()
        last_assistant_message = dspy.InputField()
        recent_turns = dspy.InputField()
        memories = dspy.InputField()

        response_text = dspy.OutputField()


    class RagReplySignature(dspy.Signature):
        """Draft a grounded RAG reply."""

        user_message = dspy.InputField()
        summary = dspy.InputField()
        active_goal = dspy.InputField()
        stage = dspy.InputField()
        pending_question = dspy.InputField()
        last_assistant_message = dspy.InputField()
        recent_turns = dspy.InputField()
        memories = dspy.InputField()
        retrieved_context = dspy.InputField()

        response_text = dspy.OutputField()


    class AppointmentReplySignature(dspy.Signature):
        """Draft an appointment booking reply."""

        user_message = dspy.InputField()
        contact_name = dspy.InputField()
        summary = dspy.InputField()
        active_goal = dspy.InputField()
        stage = dspy.InputField()
        pending_question = dspy.InputField()
        last_assistant_message = dspy.InputField()
        recent_turns = dspy.InputField()
        memories = dspy.InputField()
        appointment_state = dspy.InputField()
        booking_url = dspy.InputField()

        response_text = dspy.OutputField()


    class StateSummarySignature(dspy.Signature):
        """Update the conversation summary for the next turn."""

        current_summary = dspy.InputField()
        user_message = dspy.InputField()
        assistant_message = dspy.InputField()
        active_goal = dspy.InputField()
        stage = dspy.InputField()

        updated_summary = dspy.OutputField()

else:

    class StateRouterSignature:  # pragma: no cover - placeholder for missing dependency
        pass


    class AppointmentExtractionSignature:  # pragma: no cover - placeholder for missing dependency
        pass


    class ConversationReplySignature:  # pragma: no cover - placeholder for missing dependency
        pass


    class RagReplySignature:  # pragma: no cover - placeholder for missing dependency
        pass


    class AppointmentReplySignature:  # pragma: no cover - placeholder for missing dependency
        pass


    class StateSummarySignature:  # pragma: no cover - placeholder for missing dependency
        pass


SIGNATURES: dict[str, Any] = {
    "state_router": StateRouterSignature,
    "appointment_extraction": AppointmentExtractionSignature,
    "conversation_reply": ConversationReplySignature,
    "rag_reply": RagReplySignature,
    "appointment_reply": AppointmentReplySignature,
    "state_summary": StateSummarySignature,
}
