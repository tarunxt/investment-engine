"""Credential minimization for public copies, never persisted domain evidence.

Exact credential labels are distinguished from financial token IDs, token counts,
source IDs and numeric values. This is a narrow projection, not content validation
or a claim that arbitrary unlabeled secret strings can be detected.
"""
from __future__ import annotations

import re
from typing import Any

REDACTED = "[REDACTED]"
_EXACT = frozenset({
    "token", "password", "passwordhash", "passwd", "passphrase", "authorization", "bearer", "cookie", "setcookie",
    "secret", "secretkey", "accesskey", "secretaccesskey", "credential", "credentials", "apikey", "privatekey", "signingkey",
    "accesstoken", "refreshtoken", "idtoken", "sessiontoken", "authtoken", "ownertoken",
})
_SUFFIXES = ("password", "passwd", "secret", "secretkey", "accesskey", "secretaccesskey", "credential", "credentials", "apikey",
             "privatekey", "signingkey", "accesstoken", "refreshtoken", "sessiontoken")
_CREDENTIAL_LABEL = (r"(?:[a-z0-9_-]*(?:api[_-]?key|password(?:[_-]?hash)?|passwd|passphrase|secret|credentials?|"
                     r"private[_-]?key|signing[_-]?key|access[_-]?token|refresh[_-]?token|"
                     r"session[_-]?token)|token|authorization|cookie)")
_ASSIGNMENT = re.compile(
    r"(?i)(\b" + _CREDENTIAL_LABEL + r"\b)([\"']?\s*[:=]\s*)"
    r'''("[^"]*"|'[^']*'|\[REDACTED\]|[^\s,;|&<>{}]+)'''
)
_BEARER = re.compile(r"(?i)\bBearer\s+[a-z0-9._~+/=-]+")
_BASIC_URL = re.compile(r"(?i)(https?://)[^/\s:@]+:[^/\s@]+@")


def credential_label(label: str) -> bool:
    compact = re.sub(r"[^a-z0-9]", "", label.casefold())
    return compact in _EXACT or compact.endswith(_SUFFIXES)


def public_text(value: str) -> str:
    def replacement(match):
        token = match[3]
        quoted = token[0] in {"'", '"'}
        safe = token[0] + REDACTED + token[0] if quoted else REDACTED
        return match[1] + match[2] + safe
    # Bearer may be the value of Authorization; redact its payload before a
    # generic assignment matcher can consume only the word "Bearer".
    text = _BEARER.sub("Bearer " + REDACTED, value)
    text = _ASSIGNMENT.sub(replacement, text)
    return _BASIC_URL.sub(lambda match: match[1] + REDACTED + "@", text)


def public_value(value: Any) -> Any:
    """Fresh recursively minimized copy; source mappings/lists are untouched."""
    if isinstance(value, dict):
        return {key: REDACTED if credential_label(str(key)) else public_value(item)
                for key, item in value.items()}
    if isinstance(value, list):
        return [public_value(item) for item in value]
    if isinstance(value, tuple):
        return tuple(public_value(item) for item in value)
    if isinstance(value, str):
        return public_text(value)
    return value


def public_job_details(payload: dict) -> dict:
    """Minimize diagnostic/context fields while retaining prompt/output provenance."""
    return {key: public_value(value) if key in {
        "error_message", "export_error", "runtime_metadata_json", "request_context_json",
    } else value for key, value in payload.items()}

