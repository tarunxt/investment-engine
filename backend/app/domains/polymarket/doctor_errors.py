from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from itertools import islice
import json
import re
from typing import Any


BULLPEN_SUPPORT_REQUIRED_ERROR_CODE = "BULLPEN_SUPPORT_REQUIRED"
AUTO_LIVE_PERSISTED_ERROR_CODE_MAX_LENGTH = 64
BULLPEN_TERMINAL_SUPPORT_ERROR_CODES = frozenset(
    {
        "L2_WALLET_DISAGREEMENT",
        "PM_LEGACY_DEPOSIT_WALLET_PENDING_RECOVERY",
        "POLYMARKET_RELAYER_WALLET_NOT_REGISTERED",
        "POLYMARKET_WALLET_ROUTE_UNCONFIRMED",
    }
)

_ERROR_CODE_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]{2,127}$")
_TEXT_CODE_PATTERN = re.compile(
    r"(?:error_)?code[\"']?\s*[:=]\s*[\"']?([A-Z][A-Z0-9_]{2,127})",
    re.IGNORECASE,
)
_SAFE_TO_RETRY_PATTERN = re.compile(
    r"safe_to_retry[\"']?\s*[:=]\s*[\"']?(true|false)",
    re.IGNORECASE,
)
_SUPPORT_REQUIRED_PATTERN = re.compile(
    r"support_required[\"']?\s*[:=]\s*[\"']?(true|false)",
    re.IGNORECASE,
)
_TERMINAL_PATTERN = re.compile(
    r"terminal[\"']?\s*[:=]\s*[\"']?(true|false)",
    re.IGNORECASE,
)
_MAX_JSON_VALUES = 32
_MAX_MAPPING_DEPTH = 8
_MAX_TEXT_VALUES = 64
_MAX_ERROR_TEXT_LENGTH = 200_000


def normalize_bullpen_error_code(value: object) -> str | None:
    normalized = str(value or "").strip().upper()
    if not normalized or not _ERROR_CODE_PATTERN.fullmatch(normalized):
        return None
    return normalized


def _bounded_error_text(value: str) -> str:
    if len(value) <= _MAX_ERROR_TEXT_LENGTH:
        return value
    half = _MAX_ERROR_TEXT_LENGTH // 2
    return f"{value[:half]}\n...[truncated]...\n{value[-half:]}"


def is_terminal_bullpen_support_error_code(value: object) -> bool:
    code = normalize_bullpen_error_code(value)
    return bool(
        code
        and (
            code in BULLPEN_TERMINAL_SUPPORT_ERROR_CODES
            or code == BULLPEN_SUPPORT_REQUIRED_ERROR_CODE
        )
    )


@dataclass(frozen=True)
class BullpenDoctorFailure:
    error_code: str | None = None
    safe_to_retry: bool | None = None
    support_required: bool | None = None
    terminal: bool | None = None
    resolution_owner: str | None = None

    @property
    def is_terminal(self) -> bool:
        resolution_owner = str(self.resolution_owner or "").strip().lower()
        return bool(
            self.safe_to_retry is False
            or self.support_required is True
            or self.terminal is True
            or resolution_owner == "bullpen_support"
            or is_terminal_bullpen_support_error_code(self.error_code)
        )

    @property
    def auto_live_error_code(self) -> str:
        if not self.is_terminal:
            return "DOCTOR_READ_FAILED"
        if (
            self.error_code
            and len(self.error_code)
            <= AUTO_LIVE_PERSISTED_ERROR_CODE_MAX_LENGTH
        ):
            return self.error_code
        return BULLPEN_SUPPORT_REQUIRED_ERROR_CODE

    @property
    def retryable(self) -> bool:
        return not self.is_terminal


def _json_values_from_text(value: str) -> list[object]:
    text = value.strip()
    if not text:
        return []

    values: list[object] = []
    try:
        values.append(json.loads(text))
        return values
    except (TypeError, json.JSONDecodeError):
        pass

    decoder = json.JSONDecoder()
    for index, character in enumerate(text):
        if character not in "[{":
            continue
        try:
            parsed, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        values.append(parsed)
        if len(values) >= _MAX_JSON_VALUES:
            break
    return values


def _mapping_values(
    value: object,
    *,
    depth: int = 0,
) -> Iterable[Mapping[str, Any]]:
    if depth > _MAX_MAPPING_DEPTH:
        return
    if isinstance(value, Mapping):
        yield value
        for nested in value.values():
            yield from _mapping_values(nested, depth=depth + 1)
    elif isinstance(value, (list, tuple)):
        for nested in value:
            yield from _mapping_values(nested, depth=depth + 1)


def _nested_text_values(
    value: object,
    *,
    depth: int = 0,
) -> Iterable[str]:
    if depth > _MAX_MAPPING_DEPTH:
        return
    if isinstance(value, str):
        yield value
    elif isinstance(value, Mapping):
        for nested in value.values():
            yield from _nested_text_values(nested, depth=depth + 1)
    elif isinstance(value, (list, tuple)):
        for nested in value:
            yield from _nested_text_values(nested, depth=depth + 1)


def _first_bool(
    mappings: Iterable[Mapping[str, Any]],
    *keys: str,
) -> bool | None:
    for mapping in mappings:
        for key in keys:
            value = mapping.get(key)
            if isinstance(value, bool):
                return value
    return None


def _first_string(
    mappings: Iterable[Mapping[str, Any]],
    *keys: str,
) -> str | None:
    for mapping in mappings:
        for key in keys:
            value = mapping.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


def _text_bool(pattern: re.Pattern[str], texts: Iterable[str]) -> bool | None:
    for text in texts:
        match = pattern.search(text)
        if match:
            return match.group(1).lower() == "true"
    return None


def parse_bullpen_doctor_failure(*values: object) -> BullpenDoctorFailure:
    texts: list[str] = []
    payloads: list[object] = []

    for value in values:
        if value is None:
            continue
        if isinstance(value, Mapping):
            payloads.append(value)
            texts.extend(
                _bounded_error_text(text)
                for text in islice(
                    _nested_text_values(value),
                    _MAX_TEXT_VALUES,
                )
            )
            continue
        if isinstance(value, str):
            text = _bounded_error_text(value)
            texts.append(text)
            payloads.extend(_json_values_from_text(text))
            continue

        text = _bounded_error_text(str(value))
        texts.append(text)
        payloads.extend(_json_values_from_text(text))
        for attribute in ("stdout", "stderr"):
            stream = getattr(value, attribute, None)
            if isinstance(stream, str) and stream.strip():
                text = _bounded_error_text(stream)
                texts.append(text)
                payloads.extend(_json_values_from_text(text))

    mappings = [
        mapping
        for payload in payloads
        for mapping in _mapping_values(payload)
    ]

    code_candidates: list[tuple[int, str, Mapping[str, Any]]] = []
    for mapping in mappings:
        for key in ("error_code", "code"):
            code = normalize_bullpen_error_code(mapping.get(key))
            if not code:
                continue
            score = 100 if is_terminal_bullpen_support_error_code(code) else 0
            score += 20 * sum(
                field in mapping
                for field in (
                    "safe_to_retry",
                    "support_required",
                    "terminal",
                    "resolution_owner",
                )
            )
            code_candidates.append((score, code, mapping))

    text_code: str | None = None
    uppercase_text = "\n".join(texts).upper()
    for known_code in sorted(BULLPEN_TERMINAL_SUPPORT_ERROR_CODES):
        if known_code in uppercase_text:
            text_code = known_code
            break
    if text_code is None:
        for text in texts:
            match = _TEXT_CODE_PATTERN.search(text)
            if match:
                text_code = normalize_bullpen_error_code(match.group(1))
                if text_code:
                    break

    selected_mapping: Mapping[str, Any] | None = None
    error_code = text_code
    if code_candidates:
        _, candidate_code, selected_mapping = max(
            code_candidates,
            key=lambda candidate: candidate[0],
        )
        if (
            error_code is None
            or is_terminal_bullpen_support_error_code(candidate_code)
        ):
            error_code = candidate_code

    prioritized_mappings = (
        [selected_mapping, *mappings]
        if selected_mapping is not None
        else mappings
    )
    safe_to_retry = _first_bool(prioritized_mappings, "safe_to_retry")
    support_required = _first_bool(
        prioritized_mappings,
        "support_required",
        "requires_support",
    )
    terminal = _first_bool(prioritized_mappings, "terminal")
    resolution_owner = _first_string(
        prioritized_mappings,
        "resolution_owner",
    )

    if safe_to_retry is None:
        safe_to_retry = _text_bool(_SAFE_TO_RETRY_PATTERN, texts)
    if support_required is None:
        support_required = _text_bool(_SUPPORT_REQUIRED_PATTERN, texts)
    if terminal is None:
        terminal = _text_bool(_TERMINAL_PATTERN, texts)
    if resolution_owner is None and "BULLPEN_SUPPORT" in uppercase_text:
        resolution_owner = "bullpen_support"
    if support_required is None and "SUPPORT_REQUIRED" in uppercase_text:
        support_required = True

    return BullpenDoctorFailure(
        error_code=error_code,
        safe_to_retry=safe_to_retry,
        support_required=support_required,
        terminal=terminal,
        resolution_owner=resolution_owner,
    )
