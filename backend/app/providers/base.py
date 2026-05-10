from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass(frozen=True)
class AIProviderResponse:
    content: str
    tokens_in: int
    tokens_out: int
    cost: float
    provider: str
    model: str


class BaseAIProvider(ABC):
    provider_name: str
    supported_models: list[str] = []

    @classmethod
    @abstractmethod
    def is_configured(cls) -> bool:
        """Return True if the required API key is present in settings."""

    @abstractmethod
    def generate(self, *, prompt: str, model: str) -> AIProviderResponse:
        """Generate a normalized AI response."""
