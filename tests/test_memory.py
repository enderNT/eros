import asyncio

from app.memory_runtime.store import InMemoryLongTermMemoryStore, _normalize_store_search_results
from app.memory_runtime.types import LongTermMemoryRecord, ShortTermState, TurnMemoryInput
from app.services.barbershop_memory import BarbershopMemoryPolicy


def test_normalize_store_search_results_accepts_v2_dict_shape():
    results = {
        "results": [
            {"value": {"text": "Paciente prefiere horario matutino", "kind": "profile"}},
            {"value": {"text": "Tiene seguro activo", "kind": "profile"}},
            {"text": "Dato alternativo"},
        ]
    }

    normalized = _normalize_store_search_results(results, limit=2)

    assert [record.text for record in normalized] == ["Paciente prefiere horario matutino", "Tiene seguro activo"]


def test_normalize_store_search_results_accepts_list_shape():
    results = [
        {"text": "Primera memoria", "kind": "episode"},
        {"text": "Segunda memoria", "kind": "episode"},
    ]

    normalized = _normalize_store_search_results(results, limit=5)

    assert [record.text for record in normalized] == ["Primera memoria", "Segunda memoria"]


def test_in_memory_store_roundtrip():
    store = InMemoryLongTermMemoryStore()
    asyncio.run(
        store.save(
            "456",
            [
                LongTermMemoryRecord(kind="profile", text="Antecedente A"),
                LongTermMemoryRecord(kind="profile", text="Antecedente B"),
            ],
        )
    )

    memories = asyncio.run(store.search("456", "dolor de cabeza", limit=3))
    assert [record.text for record in memories] == ["Antecedente A", "Antecedente B"]


def test_should_store_memory_skips_trivial_turns():
    policy = BarbershopMemoryPolicy()
    memories = policy.select_records(
        TurnMemoryInput(user_message="hola", assistant_message="Hola, te ayudo con gusto", route="conversation"),
        ShortTermState(),
        {},
    )

    assert memories == []


def test_should_store_memory_persists_appointment_facts():
    policy = BarbershopMemoryPolicy()
    memories = policy.select_records(
        TurnMemoryInput(
            user_message="Quiero cita con dermatologia manana",
            assistant_message="Perfecto, lo paso a recepcion",
            route="appointment",
        ),
        ShortTermState(),
        {
            "appointment_slots": {
                "patient_name": "Juan Perez",
                "reason": "dermatologia",
                "preferred_date": "manana",
                "preferred_time": "10 am",
            }
        },
    )

    assert memories
    assert memories[0].kind == "profile"
