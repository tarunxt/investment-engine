from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from app.domains.polymarket.logger import redact_secrets

_SECRET_KEY_PATTERN = re.compile(
    r"(token|secret|api[_-]?key|authorization|bearer|cookie|session|jwt|private[_-]?key|credential|password)",
    re.IGNORECASE,
)
_CREDENTIAL_ARTIFACT_KEYS = frozenset(
    {
        "credential_artifact",
        "wallet_credential_artifact",
    }
)
_CREDENTIAL_ARTIFACT_FINGERPRINT_FIELDS = frozenset(
    {
        "inode",
        "mtime_ns",
        "size",
    }
)
_CREDENTIAL_ARTIFACT_SCALAR_KEYS = frozenset(
    {
        "wallet_credential_artifact_inode",
        "wallet_credential_artifact_mtime_ns",
        "wallet_credential_artifact_size",
    }
)


def _sanitize_credential_artifact(value: Any) -> dict[str, int | None] | str:
    """Preserve only the non-secret identity fingerprint of a credential file."""

    if not isinstance(value, Mapping):
        return "[REDACTED]"
    sanitized: dict[str, int | None] = {}
    for field_name in _CREDENTIAL_ARTIFACT_FINGERPRINT_FIELDS:
        field_value = value.get(field_name)
        if field_value is None:
            sanitized[field_name] = None
        elif isinstance(field_value, int) and not isinstance(field_value, bool):
            sanitized[field_name] = field_value
    return sanitized


def _sanitize_url(value: str) -> str:
    try:
        split = urlsplit(value)
    except ValueError:
        return redact_secrets(value)
    if not split.scheme or not split.netloc:
        return redact_secrets(value)
    query_items = []
    for key, item_value in parse_qsl(split.query, keep_blank_values=True):
        if _SECRET_KEY_PATTERN.search(key):
            query_items.append((key, "[REDACTED]"))
        else:
            query_items.append((key, item_value))
    sanitized_netloc = split.netloc
    if "@" in sanitized_netloc:
        sanitized_netloc = "[REDACTED]@"
    return urlunsplit(
        (
            split.scheme,
            sanitized_netloc,
            split.path,
            urlencode(query_items, doseq=True),
            split.fragment,
        )
    )


def sanitize_secret_value(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, bytes):
        return "[REDACTED_BYTES]"
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.startswith("http://") or stripped.startswith("https://"):
            return _sanitize_url(value)
        return redact_secrets(value)
    if isinstance(value, Mapping):
        sanitized: dict[str, Any] = {}
        for key, item in value.items():
            normalized_key = str(key)
            lower_key = normalized_key.lower()
            if lower_key in _CREDENTIAL_ARTIFACT_KEYS:
                sanitized[normalized_key] = _sanitize_credential_artifact(item)
            elif (
                lower_key in _CREDENTIAL_ARTIFACT_SCALAR_KEYS
                and (
                    item is None
                    or (
                        isinstance(item, int)
                        and not isinstance(item, bool)
                    )
                )
            ):
                sanitized[normalized_key] = item
            elif _SECRET_KEY_PATTERN.search(normalized_key):
                sanitized[normalized_key] = "[REDACTED]"
            else:
                sanitized[normalized_key] = sanitize_secret_value(item)
        return sanitized
    if isinstance(value, Sequence):
        return [sanitize_secret_value(item) for item in value]
    if hasattr(value, "model_dump"):
        return sanitize_secret_value(value.model_dump(mode="json"))
    if hasattr(value, "__dict__"):
        return sanitize_secret_value(vars(value))
    return redact_secrets(str(value))
