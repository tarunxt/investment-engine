"""Approved A9-004 Option A. Resource ceilings are not spending guarantees."""
import math
from app.shared.exceptions import AppException, ValidationException

MAX_PROMPT_CHARS = 1_048_576
MAX_PROMPT_BYTES = 2_097_152  # 2 MiB, UTF-8; both character and byte bounds apply.
MAX_BODY_BYTES = 4_194_304    # 4 MiB, actual ASGI body bytes before JSON parsing.
MAX_TARGETS = 8
MAX_PARALLEL_RUNS = 2
MAX_ACTIVE_PER_ACTOR = 4
MAX_ACTIVE_GLOBAL = 16
MAX_OUTSTANDING_PER_ACTOR = 32
MAX_OUTSTANDING_GLOBAL = 256
MAX_OUTPUT_PER_RESPONSE = 12_000
MAX_OUTPUT_PER_JOB = 48_000
REQUEST_SECONDS = 120
JOB_SECONDS = 600
MAX_TOOLS_PER_RESPONSE = 4
MAX_TOOLS_PER_JOB = 32
SDK_RETRIES = 0
RESOURCE_KEY = "a9_resource_v1"
ADMISSION_LOCK = 0x41395253  # Dedicated transaction-lock namespace, not a credential.


class ResourceBlocked(AppException):
    def __init__(self, message="Resource bounds unavailable or execution uncertain", *, quota=False):
        super().__init__(message=message, code="RESOURCE_LIMIT" if quota else "RESOURCE_BLOCKED",
                         status_code=429 if quota else 503,
                         details={"retry_after_seconds": 1} if quota else {})


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


def new_resources(now):
    return {"version": 1, "admitted_at": now, "execution_started_at": None, "deadline": None,
            "output_reserved": 0, "tools_reserved": 0, "pending": 0, "uncertain": False}


def start_resources(record, now):
    """First authorized execution only; queue waiting is not execution time."""
    if (not isinstance(record, dict) or type(record.get("version")) is not int or record.get("version") != 1 or
            record.get("deadline") is not None or record.get("execution_started_at") is not None or
            record.get("uncertain") or any(type(record.get(k)) is not int or record.get(k) != 0 for k in
                ("pending", "output_reserved", "tools_reserved"))):
        raise ResourceBlocked("Initial execution resource record is invalid")
    return {**record, "execution_started_at": now, "deadline": now + JOB_SECONDS}


def require_resources(record, now):
    if (not isinstance(record, dict) or type(record.get("version")) is not int or record.get("version") != 1 or
            record.get("uncertain") or type(record.get("deadline")) not in (int, float) or
            type(record.get("admitted_at")) not in (int, float) or
            type(record.get("execution_started_at")) not in (int, float) or
            not math.isfinite(record["deadline"]) or not math.isfinite(record["admitted_at"]) or
            not math.isfinite(record["execution_started_at"]) or
            record["execution_started_at"] < record["admitted_at"] or
            not 0 < record["deadline"] - record["execution_started_at"] <= JOB_SECONDS or now >= record["deadline"]):
        raise ResourceBlocked("Job resource deadline expired, unavailable or uncertain; no invocation authorized")
    for field in ("output_reserved", "tools_reserved", "pending"):
        if type(record.get(field)) is not int or record[field] < 0:
            raise ResourceBlocked()
    if record["output_reserved"] > MAX_OUTPUT_PER_JOB or record["tools_reserved"] > MAX_TOOLS_PER_JOB:
        raise ResourceBlocked()
    return record


def validate_provider_input(args, kwargs):
    """Bound expanded prompt/history/repair content before each SDK request."""
    stack = [kwargs[key] for key in ("input", "messages", "contents", "query", "system", "instructions", "tools", "response_format") if key in kwargs]
    stack.extend(args)
    # Reject cyclic containers without rejecting shared, acyclic history values.
    active = set()
    stack = [(value, False) for value in stack]
    if not stack:
        raise ResourceBlocked("Provider input bound cannot be established")
    chars = size = 0
    while stack:
        value, leaving = stack.pop()
        if leaving:
            active.remove(id(value))
            continue
        if isinstance(value, str):
            chars += len(value)
            try:
                size += len(value.encode("utf-8"))
            except UnicodeEncodeError:
                raise ResourceBlocked("Provider input must be valid UTF-8") from None
        elif isinstance(value, (dict, list, tuple)):
            if id(value) in active:
                raise ResourceBlocked("Cyclic provider input is not authorized")
            active.add(id(value))
            stack.append((value, True))
            # JSON keys (including schema properties and tool names) are also
            # transmitted input. Do not let an oversized key evade the bound.
            if isinstance(value, dict):
                if any(not isinstance(key, str) for key in value):
                    raise ResourceBlocked("Provider input object keys must be strings")
                children = (*value.keys(), *value.values())
            else:
                children = value
            stack.extend((child, False) for child in children)
        elif value is not None and not isinstance(value, (int, float, bool)):
            raise ResourceBlocked("Structured provider input bound is uncertified")
        if chars > MAX_PROMPT_CHARS or size > MAX_PROMPT_BYTES:
            raise ResourceBlocked("Expanded provider input exceeds the approved character/UTF-8 envelope")

