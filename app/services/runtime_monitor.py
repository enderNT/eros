from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone


@dataclass(slots=True)
class BackgroundTaskEvent:
    status: str
    conversation_id: str
    flow_id: str
    recorded_at: str
    error_type: str | None = None
    error_message: str | None = None


class BackgroundTaskMonitor:
    def __init__(self) -> None:
        self._last_success: BackgroundTaskEvent | None = None
        self._last_failure: BackgroundTaskEvent | None = None

    def record_success(self, conversation_id: str, flow_id: str) -> None:
        self._last_success = BackgroundTaskEvent(
            status="ok",
            conversation_id=conversation_id,
            flow_id=flow_id,
            recorded_at=self._timestamp(),
        )

    def record_failure(self, conversation_id: str, flow_id: str, exc: Exception) -> None:
        self._last_failure = BackgroundTaskEvent(
            status="error",
            conversation_id=conversation_id,
            flow_id=flow_id,
            recorded_at=self._timestamp(),
            error_type=type(exc).__name__,
            error_message=str(exc),
        )

    def is_degraded(self) -> bool:
        if self._last_failure is None:
            return False
        if self._last_success is None:
            return True
        return self._last_failure.recorded_at > self._last_success.recorded_at

    def snapshot(self) -> dict[str, object]:
        return {
            "status": "degraded" if self.is_degraded() else "ok",
            "last_success": self._serialize_event(self._last_success),
            "last_failure": self._serialize_event(self._last_failure),
        }

    @staticmethod
    def _serialize_event(event: BackgroundTaskEvent | None) -> dict[str, str] | None:
        if event is None:
            return None
        payload = {
            "status": event.status,
            "conversation_id": event.conversation_id,
            "flow_id": event.flow_id,
            "recorded_at": event.recorded_at,
        }
        if event.error_type is not None:
            payload["error_type"] = event.error_type
        if event.error_message is not None:
            payload["error_message"] = event.error_message
        return payload

    @staticmethod
    def _timestamp() -> str:
        return datetime.now(timezone.utc).isoformat()
