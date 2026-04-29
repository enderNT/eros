from __future__ import annotations

import re
import unicodedata
from copy import deepcopy
from difflib import SequenceMatcher
from typing import Any


TEXT_REPLY_TASKS = {"conversation_reply", "rag_reply"}

SPANISH_STOPWORDS = {
    "a",
    "al",
    "algo",
    "asi",
    "con",
    "como",
    "de",
    "del",
    "el",
    "ella",
    "en",
    "es",
    "esta",
    "este",
    "hola",
    "la",
    "las",
    "lo",
    "los",
    "me",
    "mi",
    "muy",
    "no",
    "nos",
    "o",
    "para",
    "pero",
    "por",
    "que",
    "se",
    "si",
    "sin",
    "su",
    "te",
    "tu",
    "un",
    "una",
    "uno",
    "y",
    "ya",
}

GREETING_OPEN_PATTERNS = (
    "hola",
    "buen dia",
    "buenos dias",
    "buenas tardes",
    "buenas noches",
    "mucho gusto",
    "soy eros bot",
)

CONVERSATION_COACH_STYLE_PATTERNS = (
    "puedo darte",
    "te puedo dar",
    "guia paso a paso",
    "pasos concretos",
    "tecnicas inmediatas",
    "estrategias para",
    "autocuidado",
    "ejercicios de respiracion",
    "ejercicios para calmarte",
    "anclaje",
    "distracciones suaves",
    "recursos de ayuda",
    "lugar seguro",
    "probar ejercicios",
)

CONVERSATION_DRAMATIC_STYLE_PATTERNS = (
    "siento que estes pasando por esto",
    "debe ser muy estresante",
    "lamento que te sientas asi",
    "entiendo como te puedes llegar a sentir",
    "esperando te encuentres muy bien",
    "espero que tu tambien estes muy bien",
)

CONVERSATION_SALESY_STYLE_PATTERNS = (
    "queremos ayudarte",
    "podemos ayudarte con tu problema",
    "ofrecerte soluciones",
    "todas esas terapias las ofrecemos",
    "a traves de alguno de estas soluciones",
    "podemos lograr",
    "intervencion de casos como este",
    "si gustas asistir a la clinica",
)

CONVERSATION_TRIAGE_STYLE_PATTERNS = (
    "desde cuando",
    "cuanto tiempo con el problema",
    "tienes mucho tiempo con el problema",
    "has asistido a terapia",
    "haz asistido a terapia",
    "que tratamientos has probado",
    "como esta afectando",
    "en que pais",
    "prefieres hablar en",
    "que te pasa hoy exactamente",
    "si estas en peligro inmediato",
    "contacta los servicios de emergencia",
    "linea de prevencion del suicidio",
    "linea de apoyo",
)


METRIC_PROFILES: dict[str, dict[str, Any]] = {
  "conversation_reply": {
    "description": "Metrica hibrida para respuestas conversacionales: prioriza continuidad natural, puente clinico breve y canalizacion clara, evitando saludos fuera de lugar, dramatizacion, triage por chat, tono de coach o venta forzada.",
    "criteria": [
      {
        "name": "response_similarity",
        "description": "La respuesta generada conserva la intencion y el contenido de la respuesta objetivo, con continuidad breve, tono clinico y sin dramatizar.",
        "field": "response_text",
        "scorer": "text_similarity",
        "weight": 0.22
      },
      {
        "name": "key_information_coverage",
        "description": "La respuesta generada cubre la informacion relevante presente en la respuesta objetivo y conserva la canalizacion a consulta sin desviarse a consejos, explicaciones largas ni promesas innecesarias.",
        "field": "response_text",
        "scorer": "keyword_coverage",
        "weight": 0.30,
        "min_token_length": 4
      },
      {
        "name": "follow_up_alignment",
        "description": "Si la respuesta objetivo cierra con una pregunta o siguiente paso, la respuesta generada tambien lo hace de forma breve, clinica y natural, sin abrir interrogatorios ni listas de opciones.",
        "field": "response_text",
        "scorer": "conversation_follow_up",
        "weight": 0.18
      },
      {
        "name": "greeting_alignment",
        "description": "La respuesta generada saluda solo cuando la respuesta objetivo sugiere primera interaccion; en conversaciones ya abiertas evita reabrir con saludos innecesarios.",
        "field": "response_text",
        "scorer": "conversation_greeting_alignment",
        "weight": 0.15
      },
      {
        "name": "tone_guardrails",
        "description": "La respuesta evita dramatizacion, tono vendedor, preguntas de triage o evaluacion por chat, y no se alarga innecesariamente.",
        "field": "response_text",
        "scorer": "conversation_tone_guardrails",
        "weight": 0.15
      },
    ]
  },
    "rag_reply": {
        "description": "Metrica hibrida para respuestas RAG: prioriza retener hechos clave y mantener una formulacion cercana al objetivo, sin exigir igualdad literal.",
        "criteria": [
            {
                "name": "response_similarity",
                "description": "La respuesta generada permanece cerca de la formulacion objetivo a nivel global.",
                "field": "response_text",
                "scorer": "text_similarity",
                "weight": 0.30,
            },
            {
                "name": "key_information_coverage",
                "description": "La respuesta generada conserva los hechos, terminos y valores importantes de la respuesta objetivo.",
                "field": "response_text",
                "scorer": "keyword_coverage",
                "weight": 0.50,
                "min_token_length": 4,
            },
            {
                "name": "follow_up_alignment",
                "description": "Si la respuesta objetivo propone el siguiente paso o una pregunta de cierre, la respuesta generada debe seguir esa direccion.",
                "field": "response_text",
                "scorer": "question_alignment",
                "weight": 0.20,
            },
        ],
    },
    "state_router": {
        "description": "Metrica ponderada para state_router: prioriza decidir correctamente entre los tres destinos operativos (conversation, rag o appointment), determinar si hace falta retrieval, y dejar un state_update y una razon que permitan continuar la conversacion de forma coherente.",
        "criteria": [
            {
                "name": "next_node_match",
                "description": "La decision de ruteo coincide con uno de los tres destinos operativos esperados (conversation, rag o appointment) para el caso.",
                "field": "next_node",
                "scorer": "exact_field_match",
                "weight": 0.28
            },
            {
                "name": "intent_match",
                "description": "La intencion clasificada se mantiene alineada con la accion o necesidad principal del caso, sin sobrevalorar diferencias menores de redaccion en la etiqueta.",
                "field": "intent",
                "scorer": "exact_field_match",
                "weight": 0.1
            },
            {
                "name": "needs_retrieval_type",
                "description": "needs_retrieval debe emitirse como booleano real, no como texto, numero ni valor serializado.",
                "field": "needs_retrieval",
                "scorer": "type_match",
                "expected_type": "boolean",
                "weight": 0.06
            },
            {
                "name": "needs_retrieval_match",
                "description": "La decision sobre usar retrieval coincide con si el caso requiere consultar informacion factual, actualizable o especifica antes de responder.",
                "field": "needs_retrieval",
                "scorer": "exact_field_match",
                "weight": 0.10
            },
            {
                "name": "confidence_alignment",
                "description": "La confianza se mantiene en un rango cercano al valor esperado como senal secundaria de solidez de la decision, sin pesar mas que el acierto del ruteo.",
                "field": "confidence",
                "scorer": "float_tolerance",
                "weight": 0.06,
                "tolerance": 0.05,
                "max_diff": 0.35
            },
            {
                "name": "state_update_type",
                "description": "state_update debe emitirse como objeto JSON real, no como string, etiqueta libre ni lista.",
                "field": "state_update",
                "scorer": "type_match",
                "expected_type": "object",
                "weight": 0.08
            },
            {
                "name": "state_update_coverage",
                "description": "El state_update conserva los campos operativos esperados para dar continuidad al siguiente paso de la conversacion, aunque agregue contexto adicional.",
                "field": "state_update",
                "scorer": "dict_subset_match",
                "weight": 0.18
            },
            {
                "name": "reason_similarity",
                "description": "La justificacion conserva la misma logica operativa de decision: por que ese nodo, por que si o no retrieval, y cual es el siguiente paso esperado.",
                "field": "reason",
                "scorer": "text_similarity",
                "weight": 0.14
            }
        ]
  }
}


def describe_metric_profile(task_name: str) -> dict[str, Any]:
    profile = METRIC_PROFILES[task_name]
    return {
        "description": profile["description"],
        "criteria": [deepcopy(criterion) for criterion in profile["criteria"]],
    }


def _normalize_text(value: Any) -> str:
    text = str(value or "").strip().lower()
    text = re.sub(r"\s+", " ", text)
    return text


def _normalize_match_text(value: Any) -> str:
    text = unicodedata.normalize("NFKD", _normalize_text(value))
    return "".join(character for character in text if not unicodedata.combining(character))


def _tokenize(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", _normalize_text(text))


def _extract_keywords(text: str, min_token_length: int) -> list[str]:
    keywords: list[str] = []
    for token in _tokenize(text):
        if len(token) < min_token_length:
            continue
        if token in SPANISH_STOPWORDS:
            continue
        if token not in keywords:
            keywords.append(token)
    return keywords


def _is_boolean(value: Any) -> bool:
    return isinstance(value, bool)


def _is_json_object(value: Any) -> bool:
    return isinstance(value, dict)


def _coerce_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _normalize_for_metric(task_name: str, payload: dict[str, Any]) -> dict[str, Any]:
    if task_name in TEXT_REPLY_TASKS:
        return {
            "response_text": str(payload.get("response_text", "")).strip(),
        }

    return {
        "next_node": str(payload.get("next_node", "")).strip(),
        "intent": str(payload.get("intent", "")).strip(),
        "confidence": _coerce_float(payload.get("confidence")),
        "needs_retrieval": payload.get("needs_retrieval"),
        "state_update": payload.get("state_update"),
        "reason": str(payload.get("reason", "")).strip(),
    }


def _sequence_similarity(left: str, right: str) -> float:
    normalized_left = _normalize_text(left)
    normalized_right = _normalize_text(right)
    if not normalized_left and not normalized_right:
        return 1.0
    if not normalized_left or not normalized_right:
        return 0.0
    return SequenceMatcher(a=normalized_left, b=normalized_right).ratio()


def _values_equal(expected: Any, actual: Any) -> bool:
    if _is_boolean(expected) or _is_boolean(actual):
        return _is_boolean(expected) and _is_boolean(actual) and expected == actual
    if isinstance(expected, dict) or isinstance(actual, dict):
        return isinstance(expected, dict) and isinstance(actual, dict) and expected == actual
    if isinstance(expected, list) or isinstance(actual, list):
        return isinstance(expected, list) and isinstance(actual, list) and expected == actual
    return _normalize_text(expected) == _normalize_text(actual)


def _subset_score(expected: Any, actual: Any) -> float:
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return 0.0
        actual_dict = actual
        if not expected:
            return 1.0
        matched = 0.0
        for key, expected_value in expected.items():
            if key not in actual_dict:
                continue
            matched += _subset_score(expected_value, actual_dict[key])
        return matched / len(expected)

    if isinstance(expected, list):
        if not isinstance(actual, list):
            return 0.0
        actual_list = actual
        if not expected:
            return 1.0
        matched = 0.0
        remaining = list(actual_list)
        for expected_item in expected:
            for index, candidate in enumerate(remaining):
                if _subset_score(expected_item, candidate) >= 1.0:
                    matched += 1.0
                    remaining.pop(index)
                    break
        return matched / len(expected)

    return 1.0 if _values_equal(expected, actual) else 0.0


def _score_exact_field_match(criterion: dict[str, Any], expected: dict[str, Any], actual: dict[str, Any]) -> float:
    field = criterion["field"]
    return 1.0 if _values_equal(expected.get(field), actual.get(field)) else 0.0


def _score_type_match(criterion: dict[str, Any], expected: dict[str, Any], actual: dict[str, Any]) -> float:
    del expected
    field = criterion["field"]
    expected_type = str(criterion.get("expected_type", "")).strip().lower()
    value = actual.get(field)

    if expected_type == "boolean":
        return 1.0 if _is_boolean(value) else 0.0
    if expected_type == "object":
        return 1.0 if _is_json_object(value) else 0.0
    if expected_type == "list":
        return 1.0 if isinstance(value, list) else 0.0

    return 0.0


def _score_float_tolerance(criterion: dict[str, Any], expected: dict[str, Any], actual: dict[str, Any]) -> float:
    field = criterion["field"]
    expected_value = _coerce_float(expected.get(field))
    actual_value = _coerce_float(actual.get(field))
    if expected_value is None or actual_value is None:
        return 1.0 if expected_value == actual_value else 0.0

    tolerance = float(criterion.get("tolerance", 0.05))
    max_diff = max(float(criterion.get("max_diff", tolerance)), tolerance)
    diff = abs(expected_value - actual_value)
    if diff <= tolerance:
        return 1.0
    if diff >= max_diff:
        return 0.0
    return 1.0 - ((diff - tolerance) / max(max_diff - tolerance, 1e-9))


def _score_dict_subset_match(criterion: dict[str, Any], expected: dict[str, Any], actual: dict[str, Any]) -> float:
    field = criterion["field"]
    return _subset_score(expected.get(field, {}), actual.get(field, {}))


def _score_text_similarity(criterion: dict[str, Any], expected: dict[str, Any], actual: dict[str, Any]) -> float:
    field = criterion["field"]
    return _sequence_similarity(str(expected.get(field, "")), str(actual.get(field, "")))


def _score_keyword_coverage(criterion: dict[str, Any], expected: dict[str, Any], actual: dict[str, Any]) -> float:
    field = criterion["field"]
    expected_text = str(expected.get(field, ""))
    actual_text = _normalize_text(actual.get(field, ""))
    min_token_length = int(criterion.get("min_token_length", 4))
    keywords = _extract_keywords(expected_text, min_token_length=min_token_length)
    if not keywords:
        return _sequence_similarity(expected_text, actual_text)
    matched = sum(1 for keyword in keywords if keyword in actual_text)
    return matched / len(keywords)


def _score_question_alignment(criterion: dict[str, Any], expected: dict[str, Any], actual: dict[str, Any]) -> float:
    field = criterion["field"]
    expected_text = str(expected.get(field, ""))
    actual_text = str(actual.get(field, ""))
    expected_has_question = "?" in expected_text
    actual_has_question = "?" in actual_text
    if not expected_has_question:
        return 1.0
    return 1.0 if actual_has_question else 0.0


def _score_conversation_follow_up(criterion: dict[str, Any], expected: dict[str, Any], actual: dict[str, Any]) -> float:
    base_score = _score_question_alignment(criterion, expected, actual)
    if base_score <= 0:
        return 0.0

    actual_text = str(actual.get(criterion["field"], ""))
    normalized_actual = _normalize_match_text(actual_text)
    penalty = 0.0

    matched_patterns = sum(1 for pattern in CONVERSATION_COACH_STYLE_PATTERNS if pattern in normalized_actual)
    if matched_patterns:
        penalty += min(0.70, matched_patterns * 0.18)

    if re.search(r"(?m)^\s*[-*]\s+\S", actual_text):
        penalty += 0.20

    question_count = actual_text.count("?")
    if question_count > 1:
        penalty += min(0.20, (question_count - 1) * 0.10)

    return max(0.0, base_score - penalty)


def _has_greeting_opening(text: str) -> bool:
    normalized = _normalize_match_text(text)
    return any(normalized.startswith(pattern) for pattern in GREETING_OPEN_PATTERNS)


def _score_conversation_greeting_alignment(criterion: dict[str, Any], expected: dict[str, Any], actual: dict[str, Any]) -> float:
    field = criterion["field"]
    expected_has_greeting = _has_greeting_opening(str(expected.get(field, "")))
    actual_has_greeting = _has_greeting_opening(str(actual.get(field, "")))

    if expected_has_greeting == actual_has_greeting:
        return 1.0
    if actual_has_greeting and not expected_has_greeting:
        return 0.0
    return 0.35


def _score_conversation_tone_guardrails(criterion: dict[str, Any], expected: dict[str, Any], actual: dict[str, Any]) -> float:
    del expected
    actual_text = str(actual.get(criterion["field"], ""))
    normalized_actual = _normalize_match_text(actual_text)
    penalty = 0.0

    coach_matches = sum(1 for pattern in CONVERSATION_COACH_STYLE_PATTERNS if pattern in normalized_actual)
    if coach_matches:
        penalty += min(0.40, coach_matches * 0.12)

    dramatic_matches = sum(1 for pattern in CONVERSATION_DRAMATIC_STYLE_PATTERNS if pattern in normalized_actual)
    if dramatic_matches:
        penalty += min(0.40, dramatic_matches * 0.15)

    sales_matches = sum(1 for pattern in CONVERSATION_SALESY_STYLE_PATTERNS if pattern in normalized_actual)
    if sales_matches:
        penalty += min(0.40, sales_matches * 0.15)

    triage_matches = sum(1 for pattern in CONVERSATION_TRIAGE_STYLE_PATTERNS if pattern in normalized_actual)
    if triage_matches:
        penalty += min(0.50, triage_matches * 0.16)

    question_count = actual_text.count("?")
    if question_count > 1:
        penalty += min(0.20, (question_count - 1) * 0.10)

    clinic_mentions = len(re.findall(r"\b(?:clinica|eros neuronal)\b", normalized_actual))
    if clinic_mentions > 1:
        penalty += min(0.18, (clinic_mentions - 1) * 0.09)

    word_count = len(_tokenize(actual_text))
    if word_count > 80:
        penalty += 0.12
    if word_count > 120:
        penalty += 0.18

    return max(0.0, 1.0 - penalty)


CRITERION_SCORERS = {
    "conversation_greeting_alignment": _score_conversation_greeting_alignment,
    "conversation_follow_up": _score_conversation_follow_up,
    "conversation_tone_guardrails": _score_conversation_tone_guardrails,
    "dict_subset_match": _score_dict_subset_match,
    "exact_field_match": _score_exact_field_match,
    "float_tolerance": _score_float_tolerance,
    "keyword_coverage": _score_keyword_coverage,
    "question_alignment": _score_question_alignment,
    "text_similarity": _score_text_similarity,
    "type_match": _score_type_match,
}


def score_prediction_with_details(task_name: str, expected: dict[str, Any], actual: dict[str, Any]) -> tuple[float, list[dict[str, Any]]]:
    normalized_expected = _normalize_for_metric(task_name, expected)
    normalized_actual = _normalize_for_metric(task_name, actual)
    profile = METRIC_PROFILES[task_name]

    total_weight = 0.0
    weighted_score = 0.0
    details: list[dict[str, Any]] = []

    for criterion in profile["criteria"]:
        scorer_name = criterion["scorer"]
        scorer = CRITERION_SCORERS[scorer_name]
        weight = float(criterion["weight"])
        score = max(0.0, min(1.0, scorer(criterion, normalized_expected, normalized_actual)))
        total_weight += weight
        weighted_score += score * weight
        details.append(
            {
                "name": criterion["name"],
                "description": criterion["description"],
                "field": criterion["field"],
                "scorer": scorer_name,
                "weight": weight,
                "score": round(score, 4),
                "weighted_score": round(score * weight, 4),
            }
        )

    if total_weight <= 0:
        return 0.0, details
    return weighted_score / total_weight, details
