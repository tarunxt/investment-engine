"""Existing Job VARCHAR(100) invariants, enforced before admission side effects.

These are character limits, not prompt-byte, token, fan-out or spend limits.
No identifier is truncated, normalized or included in an error response.
"""
from app.shared.exceptions import ValidationException

MODEL_IDENTIFIER_MAX_CHARS = 100


def validate_model_identifiers(provider: str, model: str) -> None:
    for field, value in (("provider", provider), ("model", model)):
        if not isinstance(value, str):
            raise ValidationException(f"{field} must be a string", {"field": field})
        if len(value) > MODEL_IDENTIFIER_MAX_CHARS:
            raise ValidationException(
                f"{field} exceeds the existing storage character limit",
                {"field": field, "max_length": MODEL_IDENTIFIER_MAX_CHARS},
            )
