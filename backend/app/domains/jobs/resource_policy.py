"""Approved Option A ingress bounds only; no spend or execution qualification."""
from app.shared.exceptions import ValidationException

MAX_PROMPT_CHARS = 1_048_576

MAX_PROMPT_BYTES = 2_097_152

MAX_BODY_BYTES = 4_194_304

MAX_TARGETS = 8

def validate_prompt(prompt):
    if not isinstance(prompt, str):
        raise ValidationException("prompt must be a string")
    if len(prompt) > MAX_PROMPT_CHARS:
        raise ValidationException("Prompt exceeds 1048576 characters; reduce the request")
    try:
        size = len(prompt.encode("utf-8"))
    except UnicodeEncodeError:
        raise ValidationException("Prompt must contain valid UTF-8 text") from None
    if size > MAX_PROMPT_BYTES:
        raise ValidationException("Prompt exceeds 2097152 UTF-8 bytes (2 MiB); reduce the request")
    return prompt

def validate_targets(targets):
    if not 1 <= len(targets) <= MAX_TARGETS:
        raise ValidationException("Select between 1 and 8 targets; repeated targets count")
    return targets
