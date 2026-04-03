from __future__ import annotations

from typing import Any

from app.memory_runtime.policy import MemoryPolicy
from app.memory_runtime.types import LongTermMemoryRecord, ShortTermState, TurnMemoryInput


class BarbershopMemoryPolicy(MemoryPolicy):
    def select_records(
        self,
        turn: TurnMemoryInput,
        short_term: ShortTermState,
        domain_state: dict[str, Any],
    ) -> list[LongTermMemoryRecord]:
        del short_term
        lowered_user = turn.user_message.lower().strip()
        lowered_assistant = turn.assistant_message.lower().strip()
        records: list[LongTermMemoryRecord] = []

        if turn.route == "appointment":
            slots = domain_state.get("appointment_slots") or {}
            relevant_bits = []
            for key in ("patient_name", "reason", "preferred_date", "preferred_time"):
                value = slots.get(key)
                if value:
                    relevant_bits.append(f"{key}={value}")
            if relevant_bits:
                records.append(
                    LongTermMemoryRecord(
                        kind="profile",
                        text="Preferencias de cita: " + ", ".join(relevant_bits),
                        metadata={"appointment_slots": dict(slots)},
                    )
                )
            elif lowered_user and not _is_trivial_turn(lowered_user):
                records.append(
                    LongTermMemoryRecord(
                        kind="episode",
                        text=f"El usuario solicito apoyo para agendar una cita: {turn.user_message}",
                    )
                )
            return records

        if _is_trivial_turn(lowered_user):
            return records

        if _looks_like_persistent_preference(lowered_user):
            records.append(
                LongTermMemoryRecord(
                    kind="profile",
                    text=f"Preferencia del usuario: {turn.user_message}",
                )
            )
            return records

        if turn.route == "rag" and lowered_assistant:
            records.append(
                LongTermMemoryRecord(
                    kind="episode",
                    text=f"Consulta informativa resuelta sobre: {turn.user_message}",
                )
            )
            return records

        if lowered_assistant and len(lowered_user) >= 18:
            records.append(
                LongTermMemoryRecord(
                    kind="episode",
                    text=f"Conversacion util: {turn.user_message} -> {turn.assistant_message}",
                )
            )
        return records


def _is_trivial_turn(user_message: str) -> bool:
    trivial_phrases = {
        "hola",
        "buenas",
        "buenos dias",
        "buenas tardes",
        "gracias",
        "ok",
        "okay",
        "si",
        "no",
    }
    compact = " ".join(user_message.split())
    return compact in trivial_phrases or len(compact) <= 3


def _looks_like_persistent_preference(user_message: str) -> bool:
    preference_markers = (
        "prefiero",
        "me gusta",
        "solo por",
        "no puedo",
        "no puedo por",
        "por favor escribeme",
        "mejor por",
    )
    return any(marker in user_message for marker in preference_markers)
