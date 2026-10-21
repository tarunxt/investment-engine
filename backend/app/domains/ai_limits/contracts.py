"""Trusted test defaults, never customer pricing or provider authorization."""
from dataclasses import dataclass
from decimal import Decimal, ROUND_CEILING, InvalidOperation
from datetime import datetime, timezone
import hashlib
import json


class BoundaryDenied(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def utc(value):
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise BoundaryDenied('AWARE_TIME_REQUIRED')
    return value.astimezone(timezone.utc)


def digest(value):
    try:
        raw = json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    except (ValueError, TypeError, RecursionError):
        raise BoundaryDenied('INVALID_BOUND_INPUT') from None
    if len(raw) > 262144:
        raise BoundaryDenied('INPUT_TOO_LARGE')
    return hashlib.sha256(raw).hexdigest()


def money(value):
    if isinstance(value, bool):
        raise BoundaryDenied('INVALID_COST')
    try:
        value = Decimal(str(value))
        if not value.is_finite() or value < 0 or value > Decimal('1000000000'):
            raise BoundaryDenied('INVALID_COST')
        return value.quantize(Decimal('.00000001'), rounding=ROUND_CEILING)
    except (InvalidOperation, ValueError):
        raise BoundaryDenied('INVALID_COST') from None


@dataclass(frozen=True)
class Limits:
    version: str = 'synthetic-limits-v1'
    tariff_version: str = 'synthetic-not-a-price-v1'
    user_daily_usd: str = '1'
    platform_daily_usd: str = '5'
    operation_usd: str = '.25'
    attempt_usd: str = '.05'
    max_attempts: int = 3
    max_input_tokens: int = 4096
    max_output_tokens: int = 1024
    max_fanout: int = 3
    user_concurrency: int = 1
    platform_concurrency: int = 2
    max_queued_per_user: int = 16
    max_queued_platform: int = 128

    def validate(self):
        if not self.version or not self.tariff_version:
            raise BoundaryDenied('UNKNOWN_TARIFF_OR_LIMITS')
        for field in ('user_daily_usd','platform_daily_usd','operation_usd','attempt_usd'):
            money(getattr(self, field))
        for field in ('max_attempts','max_input_tokens','max_output_tokens','max_fanout','user_concurrency','platform_concurrency','max_queued_per_user','max_queued_platform'):
            value = getattr(self, field)
            if type(value) is not int or not 1 <= value <= 100000:
                raise BoundaryDenied('INVALID_LIMIT')
        if self.max_attempts > 5 or self.max_fanout > 8 or self.platform_concurrency <= self.user_concurrency:
            raise BoundaryDenied('NO_NEIGHBOR_CAPACITY')
        return self
