from __future__ import annotations

import asyncio
import re
from pathlib import Path

from app.core.logging import get_logger

app_logger = get_logger(__name__)

_SECRET_PATTERNS = [
    (
        re.compile(
            r"(access[_-]?token|refresh[_-]?token|api[_-]?key|secret|private[_-]?key|credential(?:s)?|bearer|authorization|jwt|turnkey(?:[_-]?bundle)?|signing[_-]?key|rpc[_-]?url)\s*[:=]\s*[\"']?[^\"'\s]+",
            re.IGNORECASE,
        ),
        lambda match: f"{match.group(1)}=[REDACTED]",
    ),
    (
        re.compile(r"Bearer\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE),
        lambda _m: "Bearer [REDACTED]",
    ),
    (
        re.compile(r"([?&](?:token|jwt|auth|authorization|session|secret|api[_-]?key)=)[^&\s]+", re.IGNORECASE),
        lambda match: f"{match.group(1)}[REDACTED]",
    ),
    (
        re.compile(r"(https?://)([^/\s:@]+):([^/\s@]+)@", re.IGNORECASE),
        lambda match: f"{match.group(1)}[REDACTED]@",
    ),
    (
        re.compile(
            r"([?&](?:token|jwt|auth|authorization|session|secret|api[_-]?key|refresh[_-]?token)=)[^&\s]+",
            re.IGNORECASE,
        ),
        lambda match: f"{match.group(1)}[REDACTED]",
    ),
]


def redact_secrets(value: str) -> str:
    redacted = value
    for pattern, replacement in _SECRET_PATTERNS:
        redacted = pattern.sub(replacement, redacted)
    return redacted


class PolymarketFileLogger:
    def __init__(self, bot_log_path: Path, error_log_path: Path) -> None:
        self.bot_log_path = bot_log_path
        self.error_log_path = error_log_path

    async def init(self) -> None:
        await asyncio.to_thread(
            self.bot_log_path.parent.mkdir, parents=True, exist_ok=True
        )
        await asyncio.to_thread(
            self.error_log_path.parent.mkdir, parents=True, exist_ok=True
        )
        await asyncio.to_thread(self.bot_log_path.touch, exist_ok=True)
        await asyncio.to_thread(self.error_log_path.touch, exist_ok=True)

    async def info(self, message: str) -> None:
        app_logger.info("polymarket %s", redact_secrets(message))
        await self._write(self.bot_log_path, "INFO", message)

    async def warn(self, message: str) -> None:
        app_logger.warning("polymarket %s", redact_secrets(message))
        await self._write(self.bot_log_path, "WARN", message)

    async def error(self, message: str, error: Exception | None = None) -> None:
        detail = f"{message}: {error}" if error else message
        app_logger.error("polymarket %s", redact_secrets(detail), exc_info=error)
        await self._write(self.error_log_path, "ERROR", detail)

    async def _write(self, path: Path, level: str, message: str) -> None:
        line = f"{_utc_now()} {level} {redact_secrets(message)}\n"
        await asyncio.to_thread(_append_text, path, line)


def _append_text(path: Path, line: str) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(line)


def _utc_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()
