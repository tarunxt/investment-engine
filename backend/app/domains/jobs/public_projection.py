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
# Parse assignment structure, then use the SAME credential_label policy as
# nested mappings and exported headers. A second regex label allowlist drifts
# (for example SECRET_KEY/AWS_SECRET_ACCESS_KEY) and must not decide sensitivity.
_ASSIGNMENT = re.compile(r"(?i)(\b[a-z][a-z0-9_-]*\b)([\"']?\s*[:=]\s*)")
_ASSIGNMENT_VALUE = re.compile(
    r'''(?i)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[REDACTED\]|(?:Basic|Bearer)\s+(?:\[REDACTED\]|[a-z0-9._~+/=-]+)|[^\s,;|&<>{}"']+)'''
)
_BEARER = re.compile(r"(?i)\bBearer\s+[a-z0-9._~+/=-]+")
_BASIC_URL = re.compile(r"(?i)(https?://)[^/\s:@]+:[^/\s@]+@")


def credential_label(label: str) -> bool:
    compact = re.sub(r"[^a-z0-9]", "", label.casefold())
    return compact in _EXACT or compact.endswith(_SUFFIXES)


def public_text(value: str) -> str:
    parts = []
    cursor = 0
    # Scan label positions rather than consuming safe outer assignments: a
    # detail="SECRET_KEY=..." wrapper must not hide an inner labeled value.
    # This stays iterative even for deeply nested diagnostic strings.
    for match in _ASSIGNMENT.finditer(value):
        if match.start() < cursor or not credential_label(match[1]):
            continue
        supplied = _ASSIGNMENT_VALUE.match(value, match.end())
        if supplied is None:
            continue
        token = supplied[0]
        quoted = token[0] in {"'", '"'}
        safe = token[0] + REDACTED + token[0] if quoted else REDACTED
        parts.extend((value[cursor:match.end()], safe))
        cursor = supplied.end()
    parts.append(value[cursor:])
    # Complete Basic/Bearer values are consumed above, not just their schemes.
    # Retain the accepted standalone Bearer and URL-userinfo contracts too.
    text = _BEARER.sub("Bearer " + REDACTED, "".join(parts))
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

