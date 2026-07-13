from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
import re
from typing import Any, Literal


@dataclass(frozen=True)
class AIProviderResponse:
    content: str
    tokens_in: int
    tokens_out: int
    cost: float
    provider: str
    model: str
    web_search_used: bool = False
    web_search_queries: list[str] = field(default_factory=list)
    web_sources: list[str] = field(default_factory=list)


ProviderExecutionPhase = Literal[
    "configuration",
    "capability_check",
    "request",
    "web_tool",
    "response_stream",
    "response_validation",
    "output_repair",
]


def sanitize_provider_error_message(message: str | None) -> str:
    if not message:
        return "Provider request failed."
    sanitized = str(message)
    sanitized = re.sub(r"Bearer\s+[A-Za-z0-9._\-]+", "Bearer [REDACTED]", sanitized, flags=re.I)
    sanitized = re.sub(r"Authorization:\s*[^\s,;]+", "Authorization: [REDACTED]", sanitized, flags=re.I)
    sanitized = re.sub(r"sk-[A-Za-z0-9]+", "[REDACTED_OPENAI_KEY]", sanitized)
    sanitized = re.sub(r"AIza[0-9A-Za-z\-_]+", "[REDACTED_GEMINI_KEY]", sanitized)
    sanitized = re.sub(r"\b[A-Fa-f0-9]{32,}\b", "[REDACTED_TOKEN]", sanitized)
    return sanitized[:800]


@dataclass
class ProviderCallError(Exception):
    provider: str
    requested_model: str
    execution_phase: ProviderExecutionPhase
    safe_message: str
    actual_model: str | None = None
    batch_id: str | None = None
    http_status: int | None = None
    provider_error_code: str | None = None
    retryable: bool = False
    attempt: int = 1
    elapsed_seconds: float | None = None
    retry_after_seconds: float | None = None
    cause_class: str | None = None
    safe_response_excerpt: str | None = None

    def __post_init__(self) -> None:
        self.safe_message = sanitize_provider_error_message(self.safe_message)
        if self.safe_response_excerpt is not None:
            self.safe_response_excerpt = sanitize_provider_error_message(
                self.safe_response_excerpt
            )
        super().__init__(self.safe_message)

    def to_metadata(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "requested_model": self.requested_model,
            "actual_model": self.actual_model,
            "batch_id": self.batch_id,
            "execution_phase": self.execution_phase,
            "http_status": self.http_status,
            "provider_error_code": self.provider_error_code,
            "safe_message": self.safe_message,
            "retryable": self.retryable,
            "attempt": self.attempt,
            "elapsed_seconds": self.elapsed_seconds,
            "retry_after_seconds": self.retry_after_seconds,
            "cause_class": self.cause_class,
            "safe_response_excerpt": self.safe_response_excerpt,
        }


def build_provider_call_error(
    *,
    provider: str,
    requested_model: str,
    execution_phase: ProviderExecutionPhase,
    error: Exception,
    retryable: bool = False,
    attempt: int = 1,
    elapsed_seconds: float | None = None,
    actual_model: str | None = None,
    batch_id: str | None = None,
) -> ProviderCallError:
    http_status = None
    provider_error_code = None
    retry_after_seconds = None
    for attribute_name in ("status_code", "http_status", "status"):
        value = getattr(error, attribute_name, None)
        if isinstance(value, int):
            http_status = value
            break
    for attribute_name in ("code", "error_code", "type"):
        value = getattr(error, attribute_name, None)
        if isinstance(value, (str, int)):
            provider_error_code = str(value)
            break
    for attribute_name in ("retry_after", "retry_after_seconds"):
        value = getattr(error, attribute_name, None)
        if isinstance(value, (int, float)):
            retry_after_seconds = float(value)
            break
    return ProviderCallError(
        provider=provider,
        requested_model=requested_model,
        actual_model=actual_model,
        batch_id=batch_id,
        execution_phase=execution_phase,
        http_status=http_status,
        provider_error_code=provider_error_code,
        safe_message=str(error),
        retryable=retryable,
        attempt=attempt,
        elapsed_seconds=elapsed_seconds,
        retry_after_seconds=retry_after_seconds,
        cause_class=error.__class__.__name__,
    )


class BaseAIProvider(ABC):
    provider_name: str
    supported_models: list[str] = []

    @classmethod
    @abstractmethod
    def is_configured(cls) -> bool:
        """Return True if the required API key is present in settings."""

    @classmethod
    def supports_model(cls, model: str) -> bool:
        return model in cls.supported_models if cls.supported_models else True

    @abstractmethod
    def generate(self, *, prompt: str, model: str) -> AIProviderResponse:
        """Generate a normalized AI response."""
