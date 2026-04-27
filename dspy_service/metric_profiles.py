from __future__ import annotations

import json
import re
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


METRIC_PROFILES: dict[str, dict[str, Any]] = {
  "conversation_reply": {
    "description": "Metrica hibrida para respuestas conversacionales: prioriza respuestas directas, utiles y orientadas al siguiente paso, evitando repetir contexto, agregar obviedades o sobremencionar la clinica sin necesidad.",
    "criteria": [
      {
        "name": "response_similarity",
        "description": "La respuesta generada conserva la intencion y el contenido de la respuesta objetivo, con una redaccion directa y sin relleno innecesario.",
        "field": "response_text",
        "scorer": "text_similarity",
        "weight": 0.35
      },
      {
        "name": "key_information_coverage",
        "description": "La respuesta generada cubre la informacion relevante presente en la respuesta objetivo sin desviarse a detalles secundarios, obvios o promocionales que no ayudan a resolver el turno.",
        "field": "response_text",
        "scorer": "keyword_coverage",
        "weight": 0.45,
        "min_token_length": 4
      },
      {
        "name": "follow_up_alignment",
        "description": "Si la respuesta objetivo cierra con una pregunta o siguiente paso, la respuesta generada tambien lo hace, evitando abrir temas adicionales o encadenar preguntas innecesarias.",
        "field": "response_text",
        "scorer": "question_alignment",
        "weight": 0.20
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
                "name": "needs_retrieval_match",
                "description": "La decision sobre usar retrieval coincide con si el caso requiere consultar informacion factual, actualizable o especifica antes de responder.",
                "field": "needs_retrieval",
                "scorer": "exact_field_match",
                "weight": 0.16
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
                "name": "state_update_coverage",
                "description": "El state_update conserva los campos operativos esperados para dar continuidad al siguiente paso de la conversacion, aunque agregue contexto adicional.",
                "field": "state_update",
                "scorer": "dict_subset_match",
                "weight": 0.26
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


def _coerce_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "1", "yes", "si", "y", "t"}:
            return True
        if lowered in {"false", "0", "no", "", "n", "f"}:
            return False
    return bool(value)


def _coerce_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _coerce_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _normalize_for_metric(task_name: str, payload: dict[str, Any]) -> dict[str, Any]:
    if task_name in TEXT_REPLY_TASKS:
        return {
            "response_text": str(payload.get("response_text", "")).strip(),
        }

    return {
        "next_node": str(payload.get("next_node", "")).strip(),
        "intent": str(payload.get("intent", "")).strip(),
        "confidence": _coerce_float(payload.get("confidence")),
        "needs_retrieval": _coerce_bool(payload.get("needs_retrieval")),
        "state_update": _coerce_object(payload.get("state_update")),
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
    if isinstance(expected, bool) or isinstance(actual, bool):
        return _coerce_bool(expected) == _coerce_bool(actual)
    return _normalize_text(expected) == _normalize_text(actual)


def _subset_score(expected: Any, actual: Any) -> float:
    if isinstance(expected, dict):
        actual_dict = _coerce_object(actual)
        if not expected:
            return 1.0
        matched = 0.0
        for key, expected_value in expected.items():
            if key not in actual_dict:
                continue
            matched += _subset_score(expected_value, actual_dict[key])
        return matched / len(expected)

    if isinstance(expected, list):
        actual_list = actual if isinstance(actual, list) else []
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


CRITERION_SCORERS = {
    "dict_subset_match": _score_dict_subset_match,
    "exact_field_match": _score_exact_field_match,
    "float_tolerance": _score_float_tolerance,
    "keyword_coverage": _score_keyword_coverage,
    "question_alignment": _score_question_alignment,
    "text_similarity": _score_text_similarity,
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