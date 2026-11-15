"""Bounded, allowlisted extraction of provider usage, without response bodies."""
from __future__ import annotations

from collections.abc import Mapping
import math


ALIASES = {
    "input_tokens": ("input_tokens", "prompt_tokens", "prompt_token_count"),
    "output_tokens": ("output_tokens", "completion_tokens", "candidates_token_count"),
    "total_tokens": ("total_tokens", "total_token_count"),
    "cache_read_input_tokens": ("cache_read_input_tokens", "prompt_cache_hit_tokens", "cached_content_token_count"),
    "cache_write_input_tokens": ("cache_creation_input_tokens",),
    "cache_miss_input_tokens": ("prompt_cache_miss_tokens",),
    "reasoning_tokens": ("thoughts_token_count",),
    "tool_use_prompt_tokens": ("tool_use_prompt_token_count",),
    "search_units": ("credits",),
}
DETAILS = {
    "input_tokens_details": ("cached_tokens", "audio_tokens"),
    "prompt_tokens_details": ("cached_tokens", "audio_tokens"),
    "output_tokens_details": ("reasoning_tokens", "audio_tokens"),
    "completion_tokens_details": ("reasoning_tokens", "audio_tokens", "accepted_prediction_tokens", "rejected_prediction_tokens"),
    "server_tool_use": ("web_search_requests", "web_fetch_requests"),
}
_INVALID = object()


def number(value: object, *, integral: bool = False) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        if value < 0 or not math.isfinite(value) or (integral and value != int(value)):
            return None
    except (OverflowError, ValueError):
        return None
    return value


def _read(obj: object, name: str):
    try:
        return obj.get(name) if isinstance(obj, Mapping) else getattr(obj, name, None)
    except Exception:
        return _INVALID


def _container(value: object) -> bool:
    # SDK models and mappings are supported; scalar/sequence usage is malformed.
    return value is not _INVALID and value is not None and not isinstance(
        value, (str, bytes, int, float, bool, list, tuple, set)
    )


def extract_usage(response: object) -> tuple[dict | None, set[str], set[str]]:
    """Return numeric evidence and fixed field names for rejected metadata.

    No arbitrary keys, values, exception messages, or provider content survive.
    Read both known containers/aliases so one malformed field cannot hide another.
    """
    result = None
    malformed: set[str] = set()
    conflicts: set[str] = set()

    def retain(values: dict, key: str, value: int | float | None, path: str) -> None:
        if value is None or path in conflicts:
            return
        previous = values.get(key)
        if previous is not None and previous != value:
            values[key] = None
            conflicts.add(path)
        else:
            values[key] = value

    for container_name in ("usage", "usage_metadata"):
        usage = _read(response, container_name)
        if usage is None:
            continue
        if not _container(usage):
            malformed.add(container_name)
            continue
        if result is None:
            result = {key: None for key in ALIASES}
        for key, aliases in ALIASES.items():
            for alias in aliases:
                raw = _read(usage, alias)
                if raw is None:
                    continue
                value = number(raw, integral=key != "search_units")
                if value is None:
                    malformed.add(key)
                else:
                    retain(result, key, value, key)
        for name, fields in DETAILS.items():
            details = _read(usage, name)
            if details is None:
                continue
            if not _container(details):
                malformed.add(name)
                continue
            values = result.setdefault(name, {})
            for key in fields:
                raw = _read(details, key)
                value = number(raw, integral=True)
                if raw is not None and value is None:
                    malformed.add(f"{name}.{key}")
                values.setdefault(key, None)
                retain(values, key, value, f"{name}.{key}")
    return result, malformed, conflicts


def has_reported_usage(usage: object) -> bool:
    if not isinstance(usage, Mapping):
        return False
    if any(number(usage.get(key), integral=key != "search_units") is not None for key in ALIASES):
        return True
    return any(
        isinstance(usage.get(name), Mapping)
        and any(number(usage[name].get(key), integral=True) is not None for key in fields)
        for name, fields in DETAILS.items()
    )


def conflicting_usage_fields(previous: object, current: object, *, cumulative: bool = False) -> list[str]:
    """Compare overlapping evidence; cumulative snapshots may increase, not fall."""
    if not isinstance(previous, Mapping) or not isinstance(current, Mapping):
        return []
    conflicts = []
    for key in ALIASES:
        left = number(previous.get(key), integral=key != "search_units")
        right = number(current.get(key), integral=key != "search_units")
        if left is not None and right is not None and (right < left if cumulative else left != right):
            conflicts.append(key)
    for container, fields in DETAILS.items():
        left, right = previous.get(container), current.get(container)
        if not isinstance(left, Mapping) or not isinstance(right, Mapping):
            continue
        for key in fields:
            a, b = number(left.get(key), integral=True), number(right.get(key), integral=True)
            if a is not None and b is not None and (b < a if cumulative else a != b):
                conflicts.append(f"{container}.{key}")
    return sorted(conflicts)
