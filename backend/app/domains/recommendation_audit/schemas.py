from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Action = Literal["Sell All", "Trim", "Hold", "Add more", "Buy New"]
Verdict = Literal["supported", "unsupported", "insufficient_evidence"]
SCORE_FIELDS = (
    "score_rationale_cruxx", "score_rationale_technical_short_term",
    "score_rationale_technical_medium_term", "score_rationale_technical_long_term",
    "score_rationale_fundamentals_short_term", "score_rationale_fundamentals_medium_long_term",
)
WEIGHT_KEYS = ("cruxx", "technical-short", "technical-medium", "technical-long", "fundamentals-short", "fundamentals-medium-long")
POLICY_VERSION = "reversal-evidence-v1"
SCHEMA_VERSION = "recommendation-evidence-v1"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Formula(StrictModel):
    detailedRationaleMultipliers: dict[str, Decimal] = Field(default_factory=lambda: dict(zip(WEIGHT_KEYS, map(Decimal, [3, 3, 2, 1, 3, 1]))) | {"technical-scan-confidence": Decimal(1), "premarket-trend": Decimal(0), "last-5-candles-trend": Decimal(5), "mean-mode-action": Decimal(4)})
    detailedRationaleDenominator: Decimal | None = Field(default=None, gt=0, le=1000)
    actionScores: dict[Action, Decimal] = Field(default_factory=lambda: {"Sell All": Decimal("-2.5"), "Trim": Decimal("-1.5"), "Hold": Decimal(0), "Buy New": Decimal("1.5"), "Add more": Decimal("2.5")})
    technicalScanMultipliers: dict[str, Decimal] = Field(default_factory=lambda: {"bullish": Decimal(1), "bearish": Decimal(-1)})
    scoreSymbolThresholds: dict[str, Decimal] = Field(default_factory=dict, max_length=6)

    @model_validator(mode="after")
    def bounded(self):
        expected = set(WEIGHT_KEYS) | {"technical-scan-confidence", "premarket-trend", "last-5-candles-trend", "mean-mode-action"}
        if set(self.detailedRationaleMultipliers) != expected or any(abs(v) > 100 for v in self.detailedRationaleMultipliers.values()):
            raise ValueError("Complete bounded formula multipliers are required")
        if set(self.actionScores) != {"Sell All", "Trim", "Hold", "Buy New", "Add more"} or any(abs(v) > 3 for v in self.actionScores.values()):
            raise ValueError("All five action scores must be within -3..3")
        if set(self.technicalScanMultipliers) != {"bullish", "bearish"} or any(abs(v) > 100 for v in self.technicalScanMultipliers.values()):
            raise ValueError("Bounded bullish and bearish multipliers required")
        if any(abs(v) > 100 for v in self.scoreSymbolThresholds.values()):
            raise ValueError("Display thresholds must be bounded")
        return self


class AuditRunContext(StrictModel):
    formula: Formula
    objective: str | None = Field(default=None, max_length=1000)
    horizon: str | None = Field(default=None, max_length=200)
    rebalance_run_ids: list[int] = Field(default_factory=list, max_length=20)
    expected_response_hashes: dict[int, str] = Field(default_factory=dict, max_length=200)

    @field_validator("expected_response_hashes")
    @classmethod
    def revisions(cls, value):
        import re
        if any(k < 1 or not re.fullmatch(r"[0-9a-f]{64}", v) for k,v in value.items()): raise ValueError("Invalid source response revision")
        return value

    @field_validator("rebalance_run_ids")
    @classmethod
    def ids(cls, value):
        if any(type(v) is not int or v < 1 for v in value) or len(value) != len(set(value)):
            raise ValueError("Distinct positive rebalance run IDs required")
        return value


class Claim(StrictModel):
    id: str = Field(max_length=100)
    kind: Literal["close_below", "close_above", "rate_increase", "qualitative"]
    text: str = Field(max_length=2000)
    critical: bool = True
    threshold: Decimal | None = None
    start_at: datetime | None = None
    end_at: datetime | None = None


class Observation(StrictModel):
    id: str
    claim_id: str
    source_id: str
    source_url: str
    content_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    observed_at: datetime
    published_at: datetime | None = None
    available_at: datetime | None = None
    independent: bool
    stance: Literal["supports", "contradicts", "neutral", "unknown"]
    detail: str = Field(max_length=4000)
    countersearch_complete: bool = False


class VerificationCreate(StrictModel):
    current_id: str = Field(min_length=36, max_length=36)
    previous_id: str | None = Field(default=None, min_length=36, max_length=36)
    bundle_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    mode: Literal["stored_only", "external_data"] = "stored_only"
    policy_version: Literal["reversal-evidence-v1"] = POLICY_VERSION
    idempotency_key: str = Field(min_length=8, max_length=128)
    budget_usd: Decimal = Field(default=Decimal(0), ge=0, le=100, decimal_places=8)
    refresh_key: str | None = Field(default=None, min_length=8, max_length=64)


class MaterializeRequest(StrictModel):
    run_id: int = Field(ge=1)


class CalculationCapture(StrictModel):
    run_ids: list[int] = Field(min_length=1, max_length=20)
    technical_run_id: int | None = Field(default=None, ge=1)
    formula: Formula
    expected_response_hashes: dict[int, str] = Field(max_length=200)

    @field_validator("expected_response_hashes")
    @classmethod
    def hashes(cls, value):
        import re
        if any(k < 1 or not re.fullmatch(r"[0-9a-f]{64}", v) for k, v in value.items()):
            raise ValueError("Invalid output revision")
        return value
