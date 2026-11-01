"""Bounded credential-pattern redaction; not a general private-content detector."""
import logging
import re

# Cover credential-bearing connection URLs without parsing or emitting userinfo.
_USERINFO = re.compile(r"(?i)([a-z][a-z0-9+.-]*://)[^\s/<>]*@")
_BEARER = re.compile(r"(?i)\b(Bearer|Basic)\s+[^\s,;\"'<>]+")
_FIELDS = re.compile(
    r'''(?ix)(\b(?:authorization|api[-_\ ]?key|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|cookie)\b["']?\s*[:=]\s*)'''
    r'''(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\]<>]+)'''
)


def redact_sensitive_text(value: str) -> str:
    value = _USERINFO.sub(r"\1[REDACTED]@", value)
    value = _BEARER.sub(r"\1 [REDACTED]", value)
    return _FIELDS.sub(r"\1[REDACTED]", value)


class RedactingFormatter(logging.Formatter):
    """Redact final rendered messages, arguments and exception/stack text.

    Leave the shared LogRecord intact for other handlers. Custom handlers and
    structured extras need their own explicit controls.
    """

    def format(self, record: logging.LogRecord) -> str:
        return redact_sensitive_text(super().format(record))
