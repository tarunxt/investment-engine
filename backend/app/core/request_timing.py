from __future__ import annotations

from contextvars import ContextVar, Token
from dataclasses import dataclass


@dataclass
class RequestTiming:
    auth_ms: float = 0
    db_ms: float = 0
    db_queries: int = 0
    redis_ms: float = 0
    external_ms: float = 0
    serialization_ms: float = 0


_current_timing: ContextVar[RequestTiming | None] = ContextVar(
    "current_request_timing",
    default=None,
)


def begin_request_timing() -> Token[RequestTiming | None]:
    return _current_timing.set(RequestTiming())


def current_request_timing() -> RequestTiming | None:
    return _current_timing.get()


def end_request_timing(token: Token[RequestTiming | None]) -> None:
    _current_timing.reset(token)


def add_auth_duration(duration_ms: float) -> None:
    if timing := current_request_timing():
        timing.auth_ms += duration_ms


def add_database_duration(duration_ms: float) -> None:
    if timing := current_request_timing():
        timing.db_ms += duration_ms
        timing.db_queries += 1


def add_redis_duration(duration_ms: float) -> None:
    if timing := current_request_timing():
        timing.redis_ms += duration_ms


def add_external_duration(duration_ms: float) -> None:
    if timing := current_request_timing():
        timing.external_ms += duration_ms


def add_serialization_duration(duration_ms: float) -> None:
    if timing := current_request_timing():
        timing.serialization_ms += duration_ms
