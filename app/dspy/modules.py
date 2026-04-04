from __future__ import annotations

from typing import Any

from app.dspy.signatures import (
    AppointmentExtractionSignature,
    AppointmentReplySignature,
    ConversationReplySignature,
    RagReplySignature,
    StateRouterSignature,
    StateSummarySignature,
)

try:
    import dspy
except ImportError:  # pragma: no cover - exercised through runtime fallback
    dspy = None  # type: ignore[assignment]


def _build_predictor(signature: type[Any]) -> Any:
    if dspy is None:
        raise RuntimeError("DSPy is not installed. Install project dependencies to enable DSPy runtime.")
    return dspy.Predict(signature)


class StateRouterModule:
    def __init__(self, predictor: Any | None = None) -> None:
        self._predictor = predictor or _build_predictor(StateRouterSignature)

    def forward(self, **kwargs: Any) -> Any:
        return self._predictor(**kwargs)


class AppointmentExtractionModule:
    def __init__(self, predictor: Any | None = None) -> None:
        self._predictor = predictor or _build_predictor(AppointmentExtractionSignature)

    def forward(self, **kwargs: Any) -> Any:
        return self._predictor(**kwargs)


class ConversationReplyModule:
    def __init__(self, predictor: Any | None = None) -> None:
        self._predictor = predictor or _build_predictor(ConversationReplySignature)

    def forward(self, **kwargs: Any) -> Any:
        return self._predictor(**kwargs)


class RagReplyModule:
    def __init__(self, predictor: Any | None = None) -> None:
        self._predictor = predictor or _build_predictor(RagReplySignature)

    def forward(self, **kwargs: Any) -> Any:
        return self._predictor(**kwargs)


class AppointmentReplyModule:
    def __init__(self, predictor: Any | None = None) -> None:
        self._predictor = predictor or _build_predictor(AppointmentReplySignature)

    def forward(self, **kwargs: Any) -> Any:
        return self._predictor(**kwargs)


class StateSummaryModule:
    def __init__(self, predictor: Any | None = None) -> None:
        self._predictor = predictor or _build_predictor(StateSummarySignature)

    def forward(self, **kwargs: Any) -> Any:
        return self._predictor(**kwargs)
