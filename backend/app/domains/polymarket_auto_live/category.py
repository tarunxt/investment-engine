from __future__ import annotations

import re
from typing import Iterable
from urllib.parse import unquote, urlparse

CATEGORY_TRAIL_SEPARATOR = " · "
CATEGORY_SCALAR_KEYS = (
    "category",
    "primaryCategory",
    "categoryName",
    "topic",
    "categoryLabel",
    "subcategoryLabel",
    "subcategoryName",
    "parentCategoryLabel",
    "tag",
    "group",
    "type",
)
CATEGORY_COLLECTION_KEYS = (
    "tags",
    "categories",
    "breadcrumbItems",
    "primaryTag",
    "categoryBreadcrumb",
)
CATEGORY_OBJECT_LABEL_KEYS = (
    "label",
    "name",
    "title",
    "categoryLabel",
    "subcategoryLabel",
    "subcategoryName",
    "categoryName",
    "primaryCategory",
    "topic",
    "category",
)
CATEGORY_TRAIL_KEYS = (
    "category",
    "categories",
    "tags",
    "breadcrumbs",
    "breadcrumb",
    "path",
    "pathname",
    "url",
    "href",
    "link",
    "marketUrl",
    "eventUrl",
    "groupTitle",
    "groupItemTitle",
    "league",
    "tournament",
    "sport",
)
CATEGORY_PATH_KEYS = frozenset(
    {
        "path",
        "pathname",
        "url",
        "href",
        "link",
        "marketUrl",
        "eventUrl",
    }
)
GENERIC_NON_CATEGORY_LABELS = frozenset(
    {
        "binary",
        "event",
        "events",
        "featured",
        "group",
        "market",
        "markets",
        "multiple choice",
        "series",
        "tag",
    }
)
UPPERCASE_CATEGORY_SEGMENTS = frozenset(
    {"cs2", "lol", "nba", "nfl", "mlb", "nhl", "ufc", "f1"}
)
MAX_CATEGORY_NODES = 10_000

INFERRED_CATEGORY_RULES: tuple[tuple[str, tuple[re.Pattern[str], ...]], ...] = (
    (
        "Sports",
        (
            re.compile(
                r"\b(?:assists?|goals?|shots?|shots on target|saves?|tackles?|cards?|player props?)\b",
                re.IGNORECASE,
            ),
            re.compile(
                r"\b(?:nba|nfl|mlb|nhl|ncaa|soccer|football|baseball|basketball|cricket|tennis|wimbledon|atp|wta|ufc|mma|boxing|golf|formula 1|f1|world cup|premier league|champions league|la liga)\b",
                re.IGNORECASE,
            ),
            re.compile(
                r"\b[A-Za-z][A-Za-z .'\-]{2,40}\s+vs\.?\s+[A-Za-z][A-Za-z .'\-]{2,40}\b",
                re.IGNORECASE,
            ),
        ),
    ),
    (
        "Weather",
        (
            re.compile(
                r"\b(?:weather|temperature|rain|snow|hurricane|storm|tornado|heatwave|forecast|climate|wind|precipitation|monsoon|floods?)\b",
                re.IGNORECASE,
            ),
        ),
    ),
    (
        "Finance",
        (
            re.compile(
                r"\b(?:bitcoin|ethereum|solana|dogecoin|crypto|stock|stocks|share price|nasdaq|s&p|dow|oil|gold|silver|yield|bonds?|commodit(?:y|ies)|forex|inflation|interest rate|fed|etf)\b",
                re.IGNORECASE,
            ),
        ),
    ),
    (
        "Politics",
        (
            re.compile(
                r"\b(?:election|president|senate|congress|parliament|minister|government|mou|treaty|ceasefire|sanctions?|iran|trump|biden|putin|zelenskyy|netanyahu)\b",
                re.IGNORECASE,
            ),
        ),
    ),
    (
        "Social Media",
        (
            re.compile(
                r"\b(?:tweets?|x posts?|posts on x|truth social posts?|truths?)\b",
                re.IGNORECASE,
            ),
        ),
    ),
)


def normalize_category_label(value: object) -> str | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    if not isinstance(value, str):
        return None
    normalized = " ".join(value.split()).strip()
    return normalized or None


def is_missing_category(value: object) -> bool:
    normalized = normalize_category_label(value)
    return normalized is None or normalized.lower() == "uncategorized"


def _split_category_trail(value: object) -> list[str]:
    normalized = normalize_category_label(value)
    if not normalized:
        return []

    parts: list[str] = []
    for part in re.split(r"\s*·\s*", normalized):
        label = normalize_category_label(part)
        if (
            not label
            or is_missing_category(label)
            or label.lower() in GENERIC_NON_CATEGORY_LABELS
        ):
            continue
        parts.append(label)
    return parts


def _read_label_value(value: object) -> str | None:
    if isinstance(value, dict):
        for key in ("label", "name", "title"):
            label = normalize_category_label(value.get(key))
            if label:
                return label
        return None
    return normalize_category_label(value)


def _read_category_object_labels(value: dict[str, object]) -> list[str]:
    labels: list[str] = []
    seen: set[str] = set()
    for key in CATEGORY_OBJECT_LABEL_KEYS:
        for label in _split_category_trail(value.get(key)):
            normalized = label.lower()
            if normalized in seen:
                continue
            seen.add(normalized)
            labels.append(label)
    return labels


def _append_category_labels(
    target: list[str],
    seen: set[str],
    value: object,
) -> None:
    if isinstance(value, list):
        for item in value:
            _append_category_labels(target, seen, item)
        return

    labels = _read_category_object_labels(value) if isinstance(value, dict) else _split_category_trail(value)
    for label in labels:
        normalized = label.lower()
        if normalized in seen:
            continue
        seen.add(normalized)
        target.append(label)


def _title_case_category_segment(value: str) -> str:
    parts: list[str] = []
    for part in re.split(r"[\s_-]+", value):
        if not part:
            continue
        lower = part.lower()
        if lower in UPPERCASE_CATEGORY_SEGMENTS:
            parts.append(lower.upper())
            continue
        if re.fullmatch(r"dota\s*2", part, re.IGNORECASE):
            parts.append("Dota 2")
            continue
        parts.append(lower[:1].upper() + lower[1:])
    return " ".join(parts)


def _add_category_trail_label(
    labels: list[str],
    seen: set[str],
    value: object,
) -> None:
    label = _read_label_value(value)
    if not label:
        return
    normalized = label.lower()
    if normalized in seen:
        return
    seen.add(normalized)
    labels.append(label)


def _add_category_trail_from_path(
    labels: list[str],
    seen: set[str],
    value: object,
) -> None:
    if not isinstance(value, str) or not value.strip():
        return

    pathname = value.strip()
    parsed = urlparse(pathname)
    if parsed.scheme or parsed.netloc:
        pathname = parsed.path

    segments = [segment.strip() for segment in pathname.split("/") if segment.strip()]
    esports_index = next(
        (
            index
            for index, segment in enumerate(segments)
            if re.fullmatch(r"e-?sports", segment, re.IGNORECASE)
        ),
        -1,
    )
    if esports_index < 0:
        return

    for segment in segments[esports_index : esports_index + 3]:
        _add_category_trail_label(
            labels,
            seen,
            _title_case_category_segment(unquote(segment)),
        )


def _collect_deep_category_trail_labels(value: object) -> list[str]:
    labels: list[str] = []
    seen_labels: set[str] = set()
    seen_nodes: set[int] = set()
    stack: list[object] = [value]
    inspected = 0

    while stack and inspected < MAX_CATEGORY_NODES:
        current = stack.pop()
        if not isinstance(current, (dict, list)):
            continue
        current_id = id(current)
        if current_id in seen_nodes:
            continue
        seen_nodes.add(current_id)
        inspected += 1

        if isinstance(current, list):
            for item in current:
                _add_category_trail_label(labels, seen_labels, item)
                _add_category_trail_from_path(labels, seen_labels, item)
                stack.append(item)
            continue

        for key in CATEGORY_TRAIL_KEYS:
            candidate = current.get(key)
            if isinstance(candidate, list):
                for item in candidate:
                    if key not in CATEGORY_PATH_KEYS:
                        _add_category_trail_label(labels, seen_labels, item)
                    _add_category_trail_from_path(labels, seen_labels, item)
                continue
            if key not in CATEGORY_PATH_KEYS:
                _add_category_trail_label(labels, seen_labels, candidate)
            _add_category_trail_from_path(labels, seen_labels, candidate)

        stack.extend(current.values())

    return labels


def _append_current_record_category_labels(
    labels: list[str],
    seen: set[str],
    record: dict[str, object],
) -> None:
    for key in CATEGORY_SCALAR_KEYS:
        _append_category_labels(labels, seen, record.get(key))
    for key in CATEGORY_COLLECTION_KEYS:
        _append_category_labels(labels, seen, record.get(key))

    for key in CATEGORY_TRAIL_KEYS:
        candidate = record.get(key)
        if isinstance(candidate, list):
            for item in candidate:
                if key not in CATEGORY_PATH_KEYS:
                    _add_category_trail_label(labels, seen, item)
                _add_category_trail_from_path(labels, seen, item)
            continue
        if key not in CATEGORY_PATH_KEYS:
            _add_category_trail_label(labels, seen, candidate)
        _add_category_trail_from_path(labels, seen, candidate)


def collect_polymarket_record_category_labels(
    value: object,
    *,
    context_category: str | None = None,
) -> list[str]:
    labels: list[str] = []
    seen: set[str] = set()
    _append_category_labels(labels, seen, context_category)

    if not isinstance(value, dict):
        return labels

    _append_current_record_category_labels(labels, seen, value)
    return labels


def collect_polymarket_category_labels(
    value: object,
    *,
    context_category: str | None = None,
) -> list[str]:
    labels: list[str] = []
    seen: set[str] = set()
    _append_category_labels(labels, seen, context_category)

    seen_nodes: set[int] = set()
    stack: list[object] = [value]
    inspected = 0

    while stack and inspected < MAX_CATEGORY_NODES:
        current = stack.pop()
        if current is None:
            continue
        if isinstance(current, list):
            stack.extend(reversed(current))
            continue
        if not isinstance(current, dict):
            continue

        current_id = id(current)
        if current_id in seen_nodes:
            continue
        seen_nodes.add(current_id)
        inspected += 1

        _append_current_record_category_labels(labels, seen, current)

        stack.extend(reversed(list(current.values())))

    return labels


def format_polymarket_category(
    labels: Iterable[str | None],
) -> str | None:
    formatted: list[str] = []
    seen: set[str] = set()
    for value in labels:
        for label in _split_category_trail(value):
            normalized = label.lower()
            if normalized in seen:
                continue
            seen.add(normalized)
            formatted.append(label)
    if not formatted:
        return None
    return CATEGORY_TRAIL_SEPARATOR.join(formatted)


def infer_polymarket_category_from_text(
    *values: str | None,
) -> str | None:
    search_text = " ".join(
        normalized
        for normalized in (
            normalize_category_label(value).lower()
            if normalize_category_label(value)
            else None
            for value in values
        )
        if normalized
    )
    if not search_text:
        return None

    for category, patterns in INFERRED_CATEGORY_RULES:
        if any(pattern.search(search_text) for pattern in patterns):
            return category
    return None


def read_polymarket_category(
    value: object,
    *,
    context_category: str | None = None,
    inference_texts: Iterable[str | None] = (),
) -> str | None:
    category = format_polymarket_category(
        collect_polymarket_category_labels(
            value,
            context_category=context_category,
        )
    )
    if category:
        return category
    return infer_polymarket_category_from_text(
        context_category,
        *list(inference_texts),
    )


def read_polymarket_theme(
    value: object,
    *,
    context_category: str | None = None,
    inference_texts: Iterable[str | None] = (),
    default: str = "Uncategorized",
) -> str:
    return (
        read_polymarket_category(
            value,
            context_category=context_category,
            inference_texts=inference_texts,
        )
        or default
    )
