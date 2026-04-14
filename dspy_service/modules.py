from __future__ import annotations

from typing import Any

try:
    from signatures import (
        AppointmentExtractionSignature,
        AppointmentReplySignature,
        ConversationReplySignature,
        RagReplySignature,
        StateRouterSignature,
        StateSummarySignature,
    )
except ModuleNotFoundError:  # pragma: no cover - package-style fallback
    from .signatures import (  # type: ignore
        AppointmentExtractionSignature,
        AppointmentReplySignature,
        ConversationReplySignature,
        RagReplySignature,
        StateRouterSignature,
        StateSummarySignature,
    )

try:
    import dspy  # type: ignore
except Exception:  # pragma: no cover - optional dependency bootstrap
    dspy = None


def _build_predictor(signature: type[Any]) -> Any:
    if dspy is None:
        raise RuntimeError("DSPy is not installed.")
    return dspy.Predict(signature)


if dspy is not None:

    class _BaseDSPyModule(dspy.Module):
        signature: type[Any]

        def __init__(self, predictor: Any | None = None) -> None:
            super().__init__()
            self._predictor = predictor or _build_predictor(self.signature)

        def forward(self, **kwargs: Any) -> Any:
            return self._predictor(**kwargs)


    class StateRouterModule(_BaseDSPyModule):
        signature = StateRouterSignature


    class AppointmentExtractionModule(_BaseDSPyModule):
        signature = AppointmentExtractionSignature


    class ConversationReplyModule(_BaseDSPyModule):
        signature = ConversationReplySignature


    class RagReplyModule(_BaseDSPyModule):
        signature = RagReplySignature


    class AppointmentReplyModule(_BaseDSPyModule):
        signature = AppointmentReplySignature


    class StateSummaryModule(_BaseDSPyModule):
        signature = StateSummarySignature

else:

    class _BaseDSPyModule:
        signature: type[Any]

        def __init__(self, predictor: Any | None = None) -> None:
            self._predictor = predictor or _build_predictor(self.signature)

        def forward(self, **kwargs: Any) -> Any:
            return self._predictor(**kwargs)


    class StateRouterModule(_BaseDSPyModule):
        signature = StateRouterSignature


    class AppointmentExtractionModule(_BaseDSPyModule):
        signature = AppointmentExtractionSignature


    class ConversationReplyModule(_BaseDSPyModule):
        signature = ConversationReplySignature


    class RagReplyModule(_BaseDSPyModule):
        signature = RagReplySignature


    class AppointmentReplyModule(_BaseDSPyModule):
        signature = AppointmentReplySignature


    class StateSummaryModule(_BaseDSPyModule):
        signature = StateSummarySignature


MODULE_FACTORIES: dict[str, type[Any]] = {
    "state_router": StateRouterModule,
    "appointment_extraction": AppointmentExtractionModule,
    "conversation_reply": ConversationReplyModule,
    "rag_reply": RagReplyModule,
    "appointment_reply": AppointmentReplyModule,
    "state_summary": StateSummaryModule,
}
