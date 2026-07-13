from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator


Stage2SchemaVersion = Literal[2]
Stage2RuleQualityStatus = Literal["complete", "partial", "missing", "contradictory"]
Stage2DeadlineConfidence = Literal["high", "medium", "low", "unresolved"]
Stage2EvidenceSufficiency = Literal["sufficient", "insufficient", "missing"]
Stage2EvidenceSourceType = Literal[
    "official_government",
    "official_military",
    "official_company",
    "major_news",
    "specialist_news",
    "aggregator",
    "generic_landing_page",
    "unknown",
]
Stage2ClaimVerificationStatus = Literal[
    "verified",
    "supported",
    "disputed",
    "unverified",
]
Stage2ProviderResultStatus = Literal[
    "success",
    "recovered",
    "provider_failed",
    "provider_unavailable",
    "timed_out",
    "invalid_json",
    "invalid_schema",
    "missing_event",
    "evidence_blocked",
    "circuit_open",
    "cancelled",
]


class Stage2FieldProvenance(BaseModel):
    source: str | None = None
    fetched_at_utc: str | None = None
    validation_status: str | None = None
    notes: list[str] = Field(default_factory=list)


class Stage2EvidenceSource(BaseModel):
    source_id: str
    title: str | None = None
    url: str | None = None
    publisher: str | None = None
    domain: str | None = None
    published_at: str | None = None
    fetched_at: str | None = None
    source_type: Stage2EvidenceSourceType = "unknown"
    relevance_score: float = Field(default=0, ge=0, le=1)
    entity_match: bool = False
    event_date_match: bool = False
    resolution_criterion_match: bool = False
    is_generic_landing_page: bool = False
    snippet: str | None = None
    extracted_claims: list[str] = Field(default_factory=list)
    source_warning: str | None = None
    content_fingerprint: str | None = None


class Stage2EvidenceClaim(BaseModel):
    claim_id: str
    claim_text: str
    supporting_source_ids: list[str] = Field(default_factory=list)
    contradicting_source_ids: list[str] = Field(default_factory=list)
    verification_status: Stage2ClaimVerificationStatus = "unverified"
    confidence: float = Field(default=0, ge=0, le=1)


class EvidencePacketV2(BaseModel):
    schema_version: Stage2SchemaVersion = 2
    built_at_utc: str
    event_id: str
    exact_resolution_question: str | None = None
    search_objective: str | None = None
    queries: list[str] = Field(default_factory=list)
    sources: list[Stage2EvidenceSource] = Field(default_factory=list)
    claims: list[Stage2EvidenceClaim] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    sufficiency_status: Stage2EvidenceSufficiency = "missing"
    legacy_preflight_evidence_block: str | None = None

    @property
    def built_at(self) -> str:
        return self.built_at_utc

    @property
    def results(self) -> list[Stage2EvidenceSource]:
        return self.sources


class Stage2MarketContext(BaseModel):
    schema_version: Stage2SchemaVersion = 2
    event_id: str
    question_ref: str | None = None
    question_id: str | None = None
    market_id: str | None = None
    condition_id: str | None = None
    question: str
    canonical_market_url: str | None = None
    canonical_market_slug: str | None = None
    canonical_event_slug: str | None = None
    category: str | None = None
    theme: str | None = None
    outcome_labels: list[str] = Field(default_factory=list)
    current_yes_odds: float | None = Field(default=None, ge=0, le=100)
    current_no_odds: float | None = Field(default=None, ge=0, le=100)
    best_bid_cents: float | None = Field(default=None, ge=0, le=100)
    best_ask_cents: float | None = Field(default=None, ge=0, le=100)
    spread_cents: float | None = Field(default=None, ge=0)
    volume_usd: float | None = Field(default=None, ge=0)
    liquidity_usd: float | None = Field(default=None, ge=0)
    exact_resolution_rules: str | None = None
    exact_yes_definition: str | None = None
    resolution_source_description: str | None = None
    background_market_context: str | None = None
    background_context_warning: str | None = None
    resolution_timezone_name: str | None = None
    resolution_timezone_iana: str | None = None
    deadline_local: str | None = None
    deadline_utc: str | None = None
    hours_remaining: float | None = None
    deadline_source: str | None = None
    deadline_confidence: Stage2DeadlineConfidence = "unresolved"
    current_time_utc: str
    rule_quality_status: Stage2RuleQualityStatus = "missing"
    url_validation_status: str | None = None
    warnings: list[str] = Field(default_factory=list)
    field_provenance: dict[str, Stage2FieldProvenance] = Field(default_factory=dict)
    field_fetched_at: dict[str, str] = Field(default_factory=dict)
    evidence_packet: EvidencePacketV2 | None = None
    legacy_preflight_evidence_block: str | None = None


class Stage2ProviderMarketOutput(BaseModel):
    event_id: str
    question_id: str | None = None
    market_id: str | None = None
    yes_definition: str | None = None
    deadline_utc: str | None = None
    resolution_timezone: str | None = None
    hours_remaining: float | None = None
    evidence_status: str | None = None
    event_state: str | None = None
    llm_yes_odds: float | None = Field(default=None, ge=0, le=100)
    llm_no_odds: float | None = Field(default=None, ge=0, le=100)
    confidence: str | None = None
    key_evidence_source_ids: list[str] = Field(default_factory=list)
    red_flags: list[str] = Field(default_factory=list)
    rationale: str | None = None

    @field_validator("llm_yes_odds", "llm_no_odds", "hours_remaining", mode="before")
    @classmethod
    def _coerce_numeric_field(cls, value: object) -> object:
        if value is None or isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str):
            cleaned = value.replace("%", "").replace(",", "").strip()
            if not cleaned:
                return None
            try:
                return float(cleaned)
            except ValueError:
                return value
        return value

    @model_validator(mode="after")
    def _validate_probabilities(self) -> "Stage2ProviderMarketOutput":
        yes = self.llm_yes_odds
        no = self.llm_no_odds
        if yes is None and no is None:
            return self
        if yes is None and no is not None:
            self.llm_yes_odds = round(max(0, min(100, 100 - no)), 2)
            yes = self.llm_yes_odds
        if no is None and yes is not None:
            self.llm_no_odds = round(max(0, min(100, 100 - yes)), 2)
            no = self.llm_no_odds
        if yes is None or no is None:
            return self
        if abs((yes + no) - 100) > 0.5:
            raise ValueError("YES and NO probabilities must sum to 100 within tolerance.")
        self.llm_yes_odds = round(yes, 2)
        self.llm_no_odds = round(no, 2)
        return self


class Stage2ProviderBatchOutput(BaseModel):
    markets: list[Stage2ProviderMarketOutput] = Field(default_factory=list)

    @model_validator(mode="after")
    def _validate_unique_event_ids(self) -> "Stage2ProviderBatchOutput":
        seen: set[str] = set()
        duplicates: list[str] = []
        for market in self.markets:
            if market.event_id in seen:
                duplicates.append(market.event_id)
            seen.add(market.event_id)
        if duplicates:
            raise ValueError(
                f"Duplicate event_id values returned: {', '.join(sorted(set(duplicates)))}"
            )
        return self


def first_present_mapping_value(record: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in record and record[key] is not None:
            return record[key]
    return None
