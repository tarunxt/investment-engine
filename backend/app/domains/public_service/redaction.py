"""Bounded structured redaction with conservative free-text truncation.

JSON/Python literal containers keep noncredential fields. In unstructured or
malformed text, a recognized credential assignment/auth scheme redacts the
entire remaining message: guessing where a possibly quoted secret ends is not
safe. This is defense in depth, not coverage of arbitrary unlabeled secrets.
Callers must still never log raw request, provider or credential payloads.
"""
import ast
import copy
import json
import logging
import re

_NAMES=(
    'access_token','refresh_token','request_token','api_key','api_secret',
    'password','passwd','client_secret','authorization','proxy_authorization',
    'cookie','set_cookie','secret','token','private_key','jwt_signing_key',
    'uat2_jwt_signing_key','integration_encryption_keys',
)
_NORMALIZED=frozenset(re.sub(r'[^a-z0-9]','',name) for name in _NAMES)
_PATTERNS=r'[a-z0-9_-]{0,64}(?:'+'|'.join(re.escape(name).replace('_',r'[\s_-]*') for name in _NAMES)+')'
_FIELD=re.compile(r'''(?i)(?<![a-z0-9_])['"]?(?:'''+_PATTERNS+r''')['"]?\s*[:=]\s*''')
_SCHEME=re.compile(r'(?i)\b(Bearer|Basic)\s+')
_USERINFO=re.compile(r'([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@\s]+@')
_JWT=re.compile(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b')
_MAX_CHARS=65536
_MAX_DEPTH=16
_REDACTED='[redacted]'


def _sensitive(key):
    if not isinstance(key,str):return False
    normalized=re.sub(r'[^a-z0-9]','',key.lower())
    return any(normalized.endswith(name) for name in _NORMALIZED)


def _clean(value,depth):
    if depth>_MAX_DEPTH:return _REDACTED
    if isinstance(value,dict):
        return {_text(str(k),depth+1):_REDACTED if _sensitive(k) else _clean(v,depth+1) for k,v in value.items()}
    if isinstance(value,(list,tuple)):
        return [_clean(v,depth+1) for v in value]
    if isinstance(value,str):return _text(value,depth+1)
    if value is None or isinstance(value,(bool,int,float)):return value
    # Python literal sets/bytes and unsupported types do not get a potentially
    # unsafe repr. They are not operational structured log primitives.
    return _REDACTED


def _text(value,depth):
    if len(value)>_MAX_CHARS or depth>_MAX_DEPTH:return _REDACTED
    stripped=value.strip()
    if stripped.startswith(('{','[','"',"'")):
        for parse in (json.loads,ast.literal_eval):
            try:
                parsed=parse(stripped)
                if isinstance(parsed,(dict,list,tuple,str)):
                    return json.dumps(_clean(parsed,depth+1),ensure_ascii=True,allow_nan=False)
            except (ValueError,TypeError,SyntaxError,RecursionError,OverflowError):
                continue
    # Embedded escaped JSON/Python fragments may not parse as a whole log
    # message. Decode common key/quote escapes for detection only; never emit
    # the decoded text or guess offsets/value boundaries in that carrier.
    probe=value
    for _ in range(3):
        probe=re.sub(r'\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2}))',
                     lambda m:chr(int(m.group(1) or m.group(2),16)),probe)
        probe=re.sub(r"\\(['\"])",r'\1',probe)
        if probe!=value and _FIELD.search(probe):return _REDACTED
    value=_USERINFO.sub(r'\1[redacted]@',value)
    value=_JWT.sub('[redacted-jwt]',value)
    field=_FIELD.search(value)
    scheme=_SCHEME.search(value)
    # Conservatively drop all suffix text, including spaces, escaped quotes,
    # line breaks, secondary cookies and unknown authorization schemes.
    ends=[m.end() for m in (field,scheme) if m is not None]
    return value[:min(ends)]+_REDACTED if ends else value


def redact(value):
    if isinstance(value,str):return _text(value,0)
    try:
        encoded=json.dumps(value,ensure_ascii=True,allow_nan=False)
        if len(encoded)>_MAX_CHARS:return _REDACTED
        return json.dumps(_clean(value,0),ensure_ascii=True,allow_nan=False)
    except (ValueError,TypeError,RecursionError,OverflowError):
        return _REDACTED


class RedactingFormatter(logging.Formatter):
    def format(self,record):
        # Preserve the original LogRecord for other handlers. Sanitize structured
        # arguments before the formatter adds its non-JSON prefix, then sanitize
        # the rendered message/exception as a second boundary.
        safe=copy.copy(record)
        if isinstance(safe.args,tuple):safe.args=tuple(_clean(arg,0) for arg in safe.args)
        elif isinstance(safe.args,dict):safe.args=_clean(safe.args,0)
        if not isinstance(safe.msg,str):safe.msg=_clean(safe.msg,0)
        return redact(super().format(safe))
