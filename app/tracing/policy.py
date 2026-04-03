from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Protocol


class FieldPolicy(Protocol):
    def apply(self, payload: Any, *, stage: str, section: str) -> Any:
        ...


class AllowAllFieldPolicy:
    def apply(self, payload: Any, *, stage: str, section: str) -> Any:
        del stage, section
        return payload


class RedactingFieldPolicy:
    def __init__(self, redacted_keys: set[str] | None = None) -> None:
        self._redacted_keys = {key.lower() for key in (redacted_keys or set())}

    def apply(self, payload: Any, *, stage: str, section: str) -> Any:
        del stage, section
        return self._sanitize(payload)

    def _sanitize(self, value: Any) -> Any:
        if isinstance(value, Mapping):
            sanitized: dict[str, Any] = {}
            for key, inner_value in value.items():
                if str(key).lower() in self._redacted_keys:
                    sanitized[str(key)] = "[REDACTED]"
                else:
                    sanitized[str(key)] = self._sanitize(inner_value)
            return sanitized
        if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
            return [self._sanitize(item) for item in value]
        return value
