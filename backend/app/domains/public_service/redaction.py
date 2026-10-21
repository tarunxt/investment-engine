"""Defense-in-depth log formatting. Callers must still never log raw payloads."""
import logging
import re

# Preserve field names/status context while removing common credential carriers.
_FIELDS=re.compile(r'(?i)(\b(?:access_token|refresh_token|request_token|api_key|api_secret|password|client_secret|authorization|cookie|set-cookie)\b[\"\s]*[:=][\"\s]*)([^\s,;}]+)')
_HEADERS=re.compile(r'(?i)(\b(?:cookie|set-cookie)\b[\"\s]*[:=])[^\n]*')
_BEARER=re.compile(r'(?i)\bBearer\s+[^\s,;]+')
_USERINFO=re.compile(r'([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@\s]+@')
_JWT=re.compile(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b')

def redact(value):
    value=_USERINFO.sub(r'\1[redacted]@',str(value))
    value=_HEADERS.sub(r'\1[redacted]',value)
    value=_BEARER.sub('Bearer [redacted]',value)
    value=_JWT.sub('[redacted-jwt]',value)
    return _FIELDS.sub(r'\1[redacted]',value)

class RedactingFormatter(logging.Formatter):
    def format(self,record):return redact(super().format(record))
