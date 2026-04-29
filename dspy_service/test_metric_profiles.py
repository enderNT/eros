from __future__ import annotations

import unittest

from metric_profiles import describe_metric_profile, score_prediction_with_details


class MetricProfilesTest(unittest.TestCase):
    def test_conversation_reply_rewards_semantic_overlap_without_exact_match(self) -> None:
        expected = {
            "response_text": "La terapia de estimulacion tiene un costo de 1200 por sesion. Quieres agendar una cita?",
        }
        close_prediction = {
            "response_text": "La terapia de estimulacion cuesta 1200 por sesion. Te gustaria agendar cita?",
        }
        off_prediction = {
            "response_text": "Hola, cuentame mas sobre lo que te sucede para poder ayudarte.",
        }

        close_score, close_details = score_prediction_with_details("conversation_reply", expected, close_prediction)
        off_score, _ = score_prediction_with_details("conversation_reply", expected, off_prediction)

        self.assertGreater(close_score, 0.70)
        self.assertLess(off_score, close_score)
        self.assertEqual([detail["name"] for detail in close_details], [
            "response_similarity",
            "key_information_coverage",
            "follow_up_alignment",
            "greeting_alignment",
            "tone_guardrails",
        ])

    def test_conversation_reply_penalizes_coach_style_guidance(self) -> None:
        expected = {
            "response_text": "Podemos ayudarte a valorar lo que esta pasando en la clinica. Si gustas, te comparto el link para agendar una cita de evaluacion?",
        }
        clinic_prediction = {
            "response_text": "Podemos ayudarte a valorar lo que esta pasando en la clinica. Si gustas, te comparto el link para agendar una cita de evaluacion?",
        }
        coach_prediction = {
            "response_text": "Podemos ayudarte a valorar lo que esta pasando en la clinica. Puedo ofrecerte tecnicas inmediatas, ejercicios de respiracion y una guia paso a paso para calmarte. Si gustas, te comparto el link para agendar una cita de evaluacion?",
        }

        clinic_score, clinic_details = score_prediction_with_details("conversation_reply", expected, clinic_prediction)
        coach_score, coach_details = score_prediction_with_details("conversation_reply", expected, coach_prediction)

        clinic_follow_up = next(detail for detail in clinic_details if detail["name"] == "follow_up_alignment")
        coach_follow_up = next(detail for detail in coach_details if detail["name"] == "follow_up_alignment")

        self.assertGreater(clinic_score, coach_score)
        self.assertGreater(clinic_follow_up["score"], coach_follow_up["score"])
        self.assertLess(coach_follow_up["score"], 0.5)

    def test_conversation_reply_penalizes_dramatic_salesy_and_triage_tone(self) -> None:
        expected = {
            "response_text": "Gracias por contarlo. Lo adecuado es valorarlo en consulta para entender mejor lo que esta pasando. Si quieres, te comparto el enlace para agendar.",
        }
        balanced_prediction = {
            "response_text": "Gracias por contarlo. Lo adecuado es valorarlo en consulta para entender mejor lo que esta pasando. Si quieres, te comparto el enlace para agendar.",
        }
        dramatic_prediction = {
            "response_text": "Siento que estes pasando por esto. Debe ser muy estresante. En Eros Neuronal queremos ayudarte y ofrecerte soluciones. Desde cuando te sientes asi? Has asistido a terapia? Si estas en peligro inmediato contacta servicios de emergencia. Si quieres podemos ayudarte con tu problema en la clinica.",
        }

        balanced_score, balanced_details = score_prediction_with_details("conversation_reply", expected, balanced_prediction)
        dramatic_score, dramatic_details = score_prediction_with_details("conversation_reply", expected, dramatic_prediction)

        balanced_tone = next(detail for detail in balanced_details if detail["name"] == "tone_guardrails")
        dramatic_tone = next(detail for detail in dramatic_details if detail["name"] == "tone_guardrails")

        self.assertGreater(balanced_score, dramatic_score)
        self.assertGreater(balanced_tone["score"], dramatic_tone["score"])
        self.assertLess(dramatic_tone["score"], 0.5)

    def test_conversation_reply_penalizes_unnecessary_greeting_mid_thread(self) -> None:
        expected = {
            "response_text": "Para definir el numero de sesiones primero se requiere una valoracion. Si quieres, te comparto el enlace para agendar.",
        }
        aligned_prediction = {
            "response_text": "Para definir el numero de sesiones primero se requiere una valoracion. Si quieres, te comparto el enlace para agendar.",
        }
        greeting_prediction = {
            "response_text": "Hola, para definir el numero de sesiones primero se requiere una valoracion. Si quieres, te comparto el enlace para agendar.",
        }

        aligned_score, aligned_details = score_prediction_with_details("conversation_reply", expected, aligned_prediction)
        greeting_score, greeting_details = score_prediction_with_details("conversation_reply", expected, greeting_prediction)

        aligned_greeting = next(detail for detail in aligned_details if detail["name"] == "greeting_alignment")
        greeting_greeting = next(detail for detail in greeting_details if detail["name"] == "greeting_alignment")

        self.assertGreater(aligned_score, greeting_score)
        self.assertGreater(aligned_greeting["score"], greeting_greeting["score"])
        self.assertEqual(greeting_greeting["score"], 0.0)

    def test_state_router_gives_partial_credit_for_state_update_subset_and_reason_similarity(self) -> None:
        expected = {
            "next_node": "rag",
            "intent": "ask_pricing",
            "confidence": 0.90,
            "needs_retrieval": True,
            "state_update": {"stage": "lookup", "active_goal": "information"},
            "reason": "Debe consultar informacion factual de precios antes de responder.",
        }
        close_prediction = {
            "next_node": "rag",
            "intent": "ask_pricing",
            "confidence": 0.88,
            "needs_retrieval": True,
            "state_update": {"stage": "lookup", "active_goal": "information", "pending_question": ""},
            "reason": "Debe consultar informacion factual de precios para responder con precision.",
        }
        wrong_prediction = {
            "next_node": "conversation",
            "intent": "start_conversation",
            "confidence": 0.25,
            "needs_retrieval": False,
            "state_update": {"stage": "open"},
            "reason": "Solo debe conversar con el usuario.",
        }

        close_score, _ = score_prediction_with_details("state_router", expected, close_prediction)
        wrong_score, _ = score_prediction_with_details("state_router", expected, wrong_prediction)

        self.assertGreater(close_score, 0.80)
        self.assertLess(wrong_score, 0.40)

    def test_state_router_requires_real_boolean_and_json_object_types(self) -> None:
        expected = {
            "next_node": "rag",
            "intent": "ask_pricing",
            "confidence": 0.90,
            "needs_retrieval": True,
            "state_update": {"stage": "lookup", "active_goal": "information"},
            "reason": "Debe consultar informacion factual de precios antes de responder.",
        }
        wrong_types_prediction = {
            "next_node": "rag",
            "intent": "ask_pricing",
            "confidence": 0.90,
            "needs_retrieval": "true",
            "state_update": "{\"stage\": \"lookup\", \"active_goal\": \"information\"}",
            "reason": "Debe consultar informacion factual de precios antes de responder.",
        }

        score, details = score_prediction_with_details("state_router", expected, wrong_types_prediction)

        by_name = {detail["name"]: detail for detail in details}
        self.assertEqual(by_name["needs_retrieval_type"]["score"], 0.0)
        self.assertEqual(by_name["needs_retrieval_match"]["score"], 0.0)
        self.assertEqual(by_name["state_update_type"]["score"], 0.0)
        self.assertEqual(by_name["state_update_coverage"]["score"], 0.0)
        self.assertLess(score, 0.60)

    def test_metric_profile_exposes_manageable_criteria_definitions(self) -> None:
        profile = describe_metric_profile("rag_reply")

        self.assertIn("description", profile)
        self.assertEqual(
            [criterion["name"] for criterion in profile["criteria"]],
            ["response_similarity", "key_information_coverage", "follow_up_alignment"],
        )
        self.assertTrue(all("description" in criterion for criterion in profile["criteria"]))


if __name__ == "__main__":
    unittest.main()
