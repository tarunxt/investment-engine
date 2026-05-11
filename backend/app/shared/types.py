import enum
from typing import NewType

# ── Scalar value types ────────────────────────────────────────────────────────
UserId = NewType("UserId", int)
JobId = NewType("JobId", int)
PromptId = NewType("PromptId", int)


# ── Enumerations ─────────────────────────────────────────────────────────────
class JobStatus(str, enum.Enum):
    SCHEDULED = "scheduled"
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"

    # Statuses considered "active" (need polling / not terminal)
    @classmethod
    def active(cls) -> frozenset["JobStatus"]:
        return frozenset({cls.SCHEDULED, cls.PENDING, cls.PROCESSING})

    @classmethod
    def terminal(cls) -> frozenset["JobStatus"]:
        return frozenset({cls.COMPLETED, cls.FAILED})
