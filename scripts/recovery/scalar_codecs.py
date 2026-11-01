"""Versioned representative PostgreSQL scalar codecs; not a DB driver adapter.

Only listed Python/type pairs are accepted. Inputs must already be bounded scalar
values; large bytea/text must use the separate streamed Field producer contract.
"""
from datetime import date, datetime, timezone
from decimal import Decimal
import math
import struct
from uuid import UUID

from acceptance import Field

CODEC_VERSION = 'pg-scalar-v1'
TYPES = {'text', 'bytea', 'int2', 'int4', 'int8', 'bool', 'numeric',
         'float8', 'date', 'timestamp', 'timestamptz', 'uuid'}


def scalar(type_name, value, *, max_scalar_bytes=65536):
    if type_name not in TYPES or not 1 <= max_scalar_bytes <= 65536:
        raise ValueError('unsupported type or scalar limit')
    tag = ('pg_catalog.' + type_name + ':' + CODEC_VERSION).encode('ascii')
    if value is None:
        return Field(tag, None, ())
    if type_name == 'text' and type(value) is str:
        if len(value) > max_scalar_bytes:
            raise ValueError('scalar limit')
        data = value.encode('utf-8')
        if b'\0' in data:
            raise ValueError('PostgreSQL text excludes NUL')
    elif type_name == 'bytea' and type(value) is bytes:
        data = value
    elif type_name in {'int2', 'int4', 'int8'} and type(value) is int:
        bits = {'int2': 16, 'int4': 32, 'int8': 64}[type_name]
        if not -(2**(bits-1)) <= value < 2**(bits-1):
            raise ValueError('integer range')
        data = str(value).encode('ascii')
    elif type_name == 'bool' and type(value) is bool:
        data = b'1' if value else b'0'
    elif type_name == 'numeric' and type(value) is Decimal:
        # as_tuple avoids Decimal.normalize(), whose result depends on context.
        if not value.is_finite():
            data = b'NaN' if value.is_nan() else (b'-Infinity' if value.is_signed() else b'Infinity')
        else:
            sign, digits, exponent = value.as_tuple()
            if len(digits) > max_scalar_bytes:
                raise ValueError('scalar limit')
            digits = list(digits)
            while digits and digits[-1] == 0:
                digits.pop()
                exponent += 1
            data = (('' if not digits or not sign else '-') +
                    (''.join(map(str, digits)) if digits else '0') +
                    'e' + str(exponent if digits else 0)).encode('ascii')
    elif type_name == 'float8' and type(value) is float:
        # Preserve signed zero and infinities; normalize every NaN payload.
        data = bytes.fromhex('7ff8000000000000') if math.isnan(value) else struct.pack('!d', value)
    elif type_name == 'date' and type(value) is date:
        data = value.isoformat().encode('ascii')
    elif type_name in {'timestamp', 'timestamptz'} and type(value) is datetime:
        aware = value.utcoffset() is not None
        if aware != (type_name == 'timestamptz'):
            raise ValueError('timezone contract')
        if aware:
            value = value.astimezone(timezone.utc)
        data = value.isoformat(timespec='microseconds').encode('ascii')
    elif type_name == 'uuid' and type(value) is UUID:
        data = value.bytes
    else:
        raise ValueError('unsupported Python/type pair')
    if len(data) > max_scalar_bytes:
        raise ValueError('scalar limit')
    return Field(tag, len(data), (data,) if data else ())
