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
        ])

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