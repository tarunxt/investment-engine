from __future__ import annotations

import re
from typing import Literal

NormalizedAutoLiveEvidenceStatus = Literal["Low", "Moderate", "Strong"]
NormalizedAutoLiveConfidence = Literal["Low", "Medium", "High"]

_EVIDENCE_LOW_KEYS = {
    "low",
    "weak",
    "insufficient",
    "no_evidence",
    "unknown",
    "rumour_only",
    "rumor_only",
    "unverified",
}
_EVIDENCE_MODERATE_KEYS = {
    "moderate",
    "medium",
    "mixed",
    "partial",
    "conflicting",
    "conflicting_evidence",
    "mixed_evidence",
}
_EVIDENCE_STRONG_KEYS = {
    "strong",
    "high",
    "clear",
    "verified",
    "confirmed",
    "strong_evidence",
    "official",
}
_CONFIDENCE_MEDIUM_KEYS = {"medium", "moderate"}
_CONFIDENCE_HIGH_KEYS = {"high", "strong", "very_high"}


def _normalize_key(value: str | None) -> str:
    if not isinstance(value, str):
        return ""
    normalized = value.strip().lower()
    if not normalized:
        return ""
    normalized = re.sub(r"[\s\-]+", "_", normalized)
    return re.sub(r"_+", "_", normalized)


def normalize_auto_live_evidence_status(
    value: str | None,
) -> NormalizedAutoLiveEvidenceStatus:
    normalized = _normalize_key(value)
    if normalized in _EVIDENCE_MODERATE_KEYS:
        return "Moderate"
    if normalized in _EVIDENCE_STRONG_KEYS:
        return "Strong"
    return "Low"


def normalize_auto_live_confidence(value: str | None) -> NormalizedAutoLiveConfidence:
    normalized = _normalize_key(value)
    if normalized in _CONFIDENCE_MEDIUM_KEYS:
        return "Medium"
    if normalized in _CONFIDENCE_HIGH_KEYS:
        return "High"
    return "Low"
