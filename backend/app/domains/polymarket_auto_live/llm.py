from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime

from app.domains.ai_providers.factory import ProviderFactory
from app.domains.polymarket_auto_live.evidence import EvidencePacket
from app.domains.polymarket_auto_live.normalization import (
    normalize_auto_live_confidence,
    normalize_auto_live_evidence_status,
)
from app.domains.polymarket_auto_live.rules import RuleEvaluation
from app.domains.polymarket_auto_live.scanner import ScannedMarket
from app.domains.polymarket_auto_live.schemas import BullpenAutoLiveLlmOutput

PREFERRED_PROVIDERS = ("openai", "gemini", "anthropic", "deepseek")
CONFIDENCE_RANK = {"Low": 0, "Medium": 1, "High": 2}
EVIDENCE_RANK = {"Low": 0, "Moderate": 1, "Strong": 2}
BULLPEN_YES_CAMP_THRESHOLD = 60
BULLPEN_NO_CAMP_THRESHOLD = 40
BULLPEN_HIGH_RAW_SPREAD_THRESHOLD = 30
BULLPEN_PROVIDER_SHARE_THRESHOLD = 0.25
BULLPEN_OUTLIER_DISTANCE_THRESHOLD = 20
BULLPEN_RATIONALE_MISMATCH_WEIGHT = 0.35
BULLPEN_NEGATIVE_RATIONALE_PATTERNS = (
    re.compile(r"\bno credible evidence\b", re.I),
    re.compile(
        r"\bno confirmed (?:event|announcement|launch|deal|filing|approval|evidence)\b",
        re.I,
    ),
    re.compile(r"\bnot confirmed\b", re.I),
    re.compile(r"\bevent not confirmed\b", re.I),
    re.compile(r"\bno official (?:announcement|confirmation|filing)\b", re.I),
    re.compile(r"\bunlikely\b", re.I),
    re.compile(r"\bunconfirmed\b", re.I),
    re.compile(r"\brumou?r(?:ed|s)?\b", re.I),
    re.compile(r"\bspeculative\b", re.I),
)


@dataclass
class LlmConsensus:
    fair_yes_probability_pct: float | None
    fair_no_probability_pct: float | None
    average_yes: float | None
    median_yes: float | None
    trimmed_mean_yes: float | None
    iqr_yes: float | None
    trimmed_range_yes: float | None
    min_yes: float | None
    max_yes: float | None
    spread_yes: float | None
    disagreement_level: str | None
    disagreement_category: str | None
    adjudication_required: bool
    consensus_method: str | None
    rationale_mismatch_count: int
    confidence: str | None
    evidence_status: str | None
    event_state: str | None
    provider_error_rate: float


@dataclass
class LlmModelSignal:
    provider: str
    model: str
    yes_odds: float
    direction: str
    effective_weight: float
    rationale_odds_mismatch: bool
    rationale_odds_mismatch_reason: str | None


@dataclass
class ProviderSignal:
    provider: str
    median_yes_odds: float
    direction: str
    effective_weight: float
    model_count: int
    rationale_mismatch_count: int


def _round(value: float | None) -> float | None:
    if value is None:
        return None
    return round(value, 2)


def _parse_number(value: object) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        cleaned = value.replace("%", "").replace("$", "").replace(",", "").strip()
        if not cleaned:
            return None
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None


def _normalize_odds_pair(
    yes_value: float | None, no_value: float | None
) -> tuple[float | None, float | None]:
    yes = yes_value
    no = no_value
    if yes is not None and no is None:
        no = 100 - yes
    elif no is not None and yes is None:
        yes = 100 - no
    if yes is not None and no is not None:
        total = yes + no
        if total > 0 and abs(total - 100) > 0.01:
            yes = (yes / total) * 100
            no = 100 - yes
    if yes is not None:
        yes = max(0, min(100, round(yes, 2)))
    if no is not None:
        no = max(0, min(100, round(no, 2)))
    return yes, no


def _extract_json_value(text: str) -> object:
    trimmed = text.strip()
    if not trimmed:
        raise ValueError("LLM returned an empty response.")

    candidates = [trimmed]
    if "```" in trimmed:
        for chunk in trimmed.split("```"):
            chunk = chunk.strip()
            if chunk.lower().startswith("json"):
                chunk = chunk[4:].strip()
            if chunk:
                candidates.append(chunk)
    if "{" in trimmed and "}" in trimmed:
        candidates.append(trimmed[trimmed.index("{") : trimmed.rindex("}") + 1])
    if "[" in trimmed and "]" in trimmed:
        candidates.append(trimmed[trimmed.index("[") : trimmed.rindex("]") + 1])

    for candidate in candidates:
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    raise ValueError("LLM response was not valid JSON.")


def _extract_markets(parsed: object) -> list[object]:
    if isinstance(parsed, list):
        return parsed
    if not isinstance(parsed, dict):
        return []
    for key in ("markets", "questions", "predictions", "results", "items"):
        value = parsed.get(key)
        if isinstance(value, list):
            return value
    nested = parsed.get("content")
    if isinstance(nested, dict):
        return _extract_markets(nested)
    return []


def _read_str(record: dict[str, object], *keys: str) -> str | None:
    for key in keys:
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _read_str_list(record: dict[str, object], *keys: str) -> list[str]:
    for key in keys:
        value = record.get(key)
        if isinstance(value, list):
            result = [str(item).strip() for item in value if str(item).strip()]
            if result:
                return result
        if isinstance(value, str) and value.strip():
            return [value.strip()]
    return []


def _parse_single_output(
    response_text: str,
    *,
    provider: str,
    model: str,
    completed_at: str,
) -> BullpenAutoLiveLlmOutput:
    parsed = _extract_json_value(response_text)
    markets = _extract_markets(parsed)
    if not markets:
        raise ValueError("LLM response did not include any market odds.")
    record = next((item for item in markets if isinstance(item, dict)), None)
    if record is None:
        raise ValueError("LLM response market payload was malformed.")

    yes, no = _normalize_odds_pair(
        _parse_number(
            record.get("llm_yes_odds")
            or record.get("llmYesOdds")
            or record.get("yes_odds")
            or record.get("yesOdds")
            or record.get("yes_probability")
            or record.get("prob_yes")
        ),
        _parse_number(
            record.get("llm_no_odds")
            or record.get("llmNoOdds")
            or record.get("no_odds")
            or record.get("noOdds")
            or record.get("no_probability")
            or record.get("prob_no")
        ),
    )
    confidence = _read_str(record, "confidence")
    evidence_status = _read_str(record, "evidence_status", "evidenceStatus")
    return BullpenAutoLiveLlmOutput(
        provider=provider,
        model=model,
        llm_yes_odds=yes,
        llm_no_odds=no,
        confidence=(
            normalize_auto_live_confidence(confidence)
            if confidence is not None
            else None
        ),
        evidence_status=(
            normalize_auto_live_evidence_status(evidence_status)
            if evidence_status is not None
            else None
        ),
        event_state=_read_str(record, "event_state", "eventState"),
        key_evidence=_read_str_list(record, "key_evidence", "keyEvidence"),
        red_flags=_read_str_list(record, "red_flags", "redFlags"),
        rationale=_read_str(
            record,
            "rationale",
            "reasoning",
            "notes",
            "note",
            "explanation",
            "summary",
        ),
        completed_at=completed_at,
    )


def _pick_consensus_label(
    values: list[str | None],
    *,
    tie_breaker: str | None = None,
    rank_map: dict[str, int] | None = None,
) -> str | None:
    normalized = [value for value in values if isinstance(value, str) and value.strip()]
    if not normalized:
        return None
    counts: dict[str, int] = {}
    for value in normalized:
        counts[value] = counts.get(value, 0) + 1
    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    if len(ranked) > 1 and ranked[0][1] == ranked[1][1]:
        if rank_map:
            return min(
                (item[0] for item in ranked if item[0] in rank_map),
                key=lambda label: rank_map[label],
                default=tie_breaker,
            )
        return tie_breaker
    return ranked[0][0]


def _average(values: list[float]) -> float | None:
    if not values:
        return None
    return _round(sum(values) / len(values))


def _median(values: list[float]) -> float | None:
    if not values:
        return None
    sorted_values = sorted(values)
    midpoint = len(sorted_values) // 2
    if len(sorted_values) % 2 == 1:
        return _round(sorted_values[midpoint])
    return _round((sorted_values[midpoint - 1] + sorted_values[midpoint]) / 2)


def _trimmed_mean(values: list[float]) -> float | None:
    if not values:
        return None
    sorted_values = sorted(values)
    trim_count = max(1, len(sorted_values) // 10) if len(sorted_values) >= 5 else 0
    trimmed = (
        sorted_values[trim_count : len(sorted_values) - trim_count]
        if trim_count and trim_count * 2 < len(sorted_values)
        else sorted_values
    )
    return _average(trimmed)


def _trimmed_values(values: list[float]) -> list[float]:
    if not values:
        return []
    sorted_values = sorted(values)
    trim_count = max(1, len(sorted_values) // 10) if len(sorted_values) >= 5 else 0
    if trim_count and trim_count * 2 < len(sorted_values):
        return sorted_values[trim_count : len(sorted_values) - trim_count]
    return sorted_values


def _quantile(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    sorted_values = sorted(values)
    clamped_quantile = min(1.0, max(0.0, quantile))
    position = (len(sorted_values) - 1) * clamped_quantile
    lower_index = int(position)
    upper_index = min(len(sorted_values) - 1, lower_index + 1)
    lower_value = sorted_values[lower_index]
    upper_value = sorted_values[upper_index]
    if lower_index == upper_index:
        return _round(lower_value)
    return _round(lower_value + (upper_value - lower_value) * (position - lower_index))


def _iqr(values: list[float]) -> float | None:
    if len(values) < 2:
        return 0.0
    q1 = _quantile(values, 0.25)
    q3 = _quantile(values, 0.75)
    if q1 is None or q3 is None:
        return 0.0
    return _round(q3 - q1)


def _trimmed_range(values: list[float]) -> float | None:
    trimmed = _trimmed_values(values)
    if not trimmed:
        return None
    return _round(trimmed[-1] - trimmed[0])


def _classify_direction(yes_odds: float | None) -> str | None:
    if yes_odds is None:
        return None
    if yes_odds >= BULLPEN_YES_CAMP_THRESHOLD:
        return "YES_CAMP"
    if yes_odds <= BULLPEN_NO_CAMP_THRESHOLD:
        return "NO_CAMP"
    return "UNCERTAIN"


def _detect_rationale_odds_mismatch(
    rationale: str | None,
    yes_odds: float | None,
) -> tuple[bool, str | None, float]:
    if not rationale or yes_odds is None:
        return False, None, 1.0
    has_negative_signal = any(pattern.search(rationale) for pattern in BULLPEN_NEGATIVE_RATIONALE_PATTERNS)
    rationale_odds_mismatch = has_negative_signal and yes_odds >= 45
    return (
        rationale_odds_mismatch,
        (
            "Rationale leans against a confirmed Yes case, but the quoted odds stayed near 50/50 or Yes-favoring."
            if rationale_odds_mismatch
            else None
        ),
        BULLPEN_RATIONALE_MISMATCH_WEIGHT if rationale_odds_mismatch else 1.0,
    )


def _build_model_signals(outputs: list[BullpenAutoLiveLlmOutput]) -> list[LlmModelSignal]:
    signals: list[LlmModelSignal] = []
    for output in outputs:
        if output.error is not None or output.llm_yes_odds is None:
            continue
        mismatch, mismatch_reason, effective_weight = _detect_rationale_odds_mismatch(
            output.rationale,
            output.llm_yes_odds,
        )
        direction = _classify_direction(output.llm_yes_odds) or "UNCERTAIN"
        output.direction = direction
        output.rationale_odds_mismatch = mismatch
        output.rationale_odds_mismatch_reason = mismatch_reason
        output.effective_weight = effective_weight
        signals.append(
            LlmModelSignal(
                provider=output.provider,
                model=output.model,
                yes_odds=output.llm_yes_odds,
                direction=direction,
                effective_weight=effective_weight,
                rationale_odds_mismatch=mismatch,
                rationale_odds_mismatch_reason=mismatch_reason,
            )
        )
    return signals


def _build_provider_signals(model_signals: list[LlmModelSignal]) -> list[ProviderSignal]:
    grouped: dict[str, dict[str, object]] = {}
    for signal in model_signals:
        provider_group = grouped.setdefault(
            signal.provider,
            {
                "yes_values": [],
                "weights": [],
                "rationale_mismatch_count": 0,
            },
        )
        yes_values = provider_group["yes_values"]
        weights = provider_group["weights"]
        assert isinstance(yes_values, list)
        assert isinstance(weights, list)
        yes_values.append(signal.yes_odds)
        weights.append(signal.effective_weight)
        if signal.rationale_odds_mismatch:
            provider_group["rationale_mismatch_count"] = int(
                provider_group["rationale_mismatch_count"]
            ) + 1

    providers: list[ProviderSignal] = []
    for provider_name, provider_group in grouped.items():
        yes_values = provider_group["yes_values"]
        weights = provider_group["weights"]
        assert isinstance(yes_values, list)
        assert isinstance(weights, list)
        median_yes_odds = _median([float(value) for value in yes_values])
        if median_yes_odds is None:
            continue
        providers.append(
            ProviderSignal(
                provider=provider_name,
                median_yes_odds=median_yes_odds,
                direction=_classify_direction(median_yes_odds) or "UNCERTAIN",
                effective_weight=_average([float(value) for value in weights]) or 1.0,
                model_count=len(yes_values),
                rationale_mismatch_count=int(provider_group["rationale_mismatch_count"]),
            )
        )
    return providers


def _summarize_direction_support(
    items: list[LlmModelSignal] | list[ProviderSignal],
) -> tuple[dict[str, int], dict[str, float]]:
    counts = {"YES_CAMP": 0, "NO_CAMP": 0, "UNCERTAIN": 0}
    weights = {"YES_CAMP": 0.0, "NO_CAMP": 0.0, "UNCERTAIN": 0.0}
    for item in items:
        counts[item.direction] += 1
        weights[item.direction] += item.effective_weight
    total_weight = sum(weights.values())
    if total_weight <= 0:
        return counts, {"YES_CAMP": 0.0, "NO_CAMP": 0.0, "UNCERTAIN": 0.0}
    return counts, {
        "YES_CAMP": round(weights["YES_CAMP"] / total_weight, 2),
        "NO_CAMP": round(weights["NO_CAMP"] / total_weight, 2),
        "UNCERTAIN": round(weights["UNCERTAIN"] / total_weight, 2),
    }


def _count_outlier_models(
    model_signals: list[LlmModelSignal],
    median_yes: float | None,
    iqr_yes: float | None,
) -> int:
    if median_yes is None:
        return 0
    distance_threshold = max(
        BULLPEN_OUTLIER_DISTANCE_THRESHOLD,
        (iqr_yes or 0.0) * 1.5,
    )
    return len(
        [
            signal
            for signal in model_signals
            if abs(signal.yes_odds - median_yes) >= distance_threshold
        ]
    )


def resolve_auto_live_llm_targets() -> list[tuple[str, str]]:
    targets: list[tuple[str, str]] = []
    for provider_name in PREFERRED_PROVIDERS:
        resolved = ProviderFactory.resolve_default_target(provider_name, "")
        if resolved is None:
            continue
        targets.append(resolved)
    return targets


def build_market_prompt(
    market: ScannedMarket,
    rules: RuleEvaluation,
    evidence_packet: EvidencePacket,
) -> str:
    evidence_lines = "\n".join(
        [
            f"- {item.title} | {item.url or 'no-url'} | {item.published_date or 'date-unknown'} | {item.content}"
            for item in evidence_packet.results
        ]
    ) or "- No reliable external evidence packet results were retrieved."
    warning_lines = "\n".join(f"- {warning}" for warning in evidence_packet.warnings) or "- None"

    return f"""
You are an independent probability estimation engine for Polymarket markets.

Analyze the market using ONLY the shared market rules and shared evidence packet below.
Do not browse or use evidence outside this packet.
Do not reason from the market title alone.

Market:
- question: {market.question}
- market_id: {market.market_id}
- slug: {market.slug or "unknown"}
- market_url: {market.market_url or "unknown"}
- current_yes_odds: {market.current_yes_odds if market.current_yes_odds is not None else "unknown"}
- current_no_odds: {market.current_no_odds if market.current_no_odds is not None else "unknown"}
- close_time_utc: {market.close_time or "unknown"}
- theme: {market.theme}

Shared market rules:
- yes_definition: {rules.yes_definition or "unknown"}
- resolution_criteria: {rules.resolution_criteria or "unknown"}
- deadline_et: {rules.deadline_et or "unknown"}
- hours_remaining: {rules.hours_remaining if rules.hours_remaining is not None else "unknown"}

Shared evidence packet:
- built_at_utc: {evidence_packet.built_at}
- queries: {", ".join(evidence_packet.queries) or "none"}
- warnings:
{warning_lines}
- evidence:
{evidence_lines}

Return strict JSON only with a top-level "markets" array containing exactly one object.
Use this schema:
{{
  "markets": [
    {{
      "question": "{market.question}",
      "yes_definition": "string",
      "deadline_et": "YYYY-MM-DD hh:mm:ss AM/PM ET",
      "hours_remaining": 24.5,
      "evidence_status": "Low | Moderate | Strong",
      "event_state": "already_occurred | scheduled_not_occurred | preparatory_only | rumour_only | no_confirmed_event | conflicting",
      "llm_yes_odds": 50.0,
      "llm_no_odds": 50.0,
      "confidence": "Low | Medium | High",
      "key_evidence": ["fact 1", "fact 2"],
      "red_flags": ["risk 1"],
      "rationale": "short explanation"
    }}
  ]
}}
""".strip()


def run_llm_consensus(
    market: ScannedMarket,
    rules: RuleEvaluation,
    evidence_packet: EvidencePacket,
) -> tuple[list[BullpenAutoLiveLlmOutput], LlmConsensus]:
    targets = resolve_auto_live_llm_targets()
    outputs: list[BullpenAutoLiveLlmOutput] = []
    prompt = build_market_prompt(market, rules, evidence_packet)

    for provider_name, model_name in targets:
        completed_at = datetime.now(UTC).isoformat()
        try:
            provider = ProviderFactory.create(provider_name)
            result = provider.generate(prompt=prompt, model=model_name)
            outputs.append(
                _parse_single_output(
                    result.content,
                    provider=result.provider,
                    model=result.model,
                    completed_at=completed_at,
                )
            )
        except Exception as exc:
            outputs.append(
                BullpenAutoLiveLlmOutput(
                    provider=provider_name,
                    model=model_name,
                    error=str(exc),
                    completed_at=completed_at,
                )
            )

    model_signals = _build_model_signals(outputs)
    usable_yes_values = [signal.yes_odds for signal in model_signals]
    provider_signals = _build_provider_signals(model_signals)
    error_count = len([output for output in outputs if output.error])
    provider_error_rate = round(error_count / len(outputs), 4) if outputs else 1.0

    if not usable_yes_values:
        return outputs, LlmConsensus(
            fair_yes_probability_pct=None,
            fair_no_probability_pct=None,
            average_yes=None,
            median_yes=None,
            trimmed_mean_yes=None,
            iqr_yes=None,
            trimmed_range_yes=None,
            min_yes=None,
            max_yes=None,
            spread_yes=None,
            disagreement_level=None,
            disagreement_category=None,
            adjudication_required=True,
            consensus_method=None,
            rationale_mismatch_count=0,
            confidence=None,
            evidence_status=None,
            event_state=None,
            provider_error_rate=provider_error_rate,
        )

    consensus_yes_values = (
        [provider.median_yes_odds for provider in provider_signals]
        if len(provider_signals) >= 2
        else usable_yes_values
    )
    average_yes = _average(consensus_yes_values)
    median_yes = _median(consensus_yes_values)
    trimmed_mean_yes = _trimmed_mean(consensus_yes_values)
    iqr_yes = _iqr(consensus_yes_values)
    trimmed_range_yes = _trimmed_range(consensus_yes_values)
    min_yes = _round(min(usable_yes_values))
    max_yes = _round(max(usable_yes_values))
    spread_yes = (
        _round((max_yes or 0) - (min_yes or 0))
        if min_yes is not None and max_yes is not None
        else None
    )
    model_counts, _ = _summarize_direction_support(model_signals)
    _, provider_shares = _summarize_direction_support(
        provider_signals if len(provider_signals) >= 2 else model_signals
    )
    model_two_sided_support = (
        model_counts["YES_CAMP"] >= 2 and model_counts["NO_CAMP"] >= 2
    )
    provider_two_sided_support = (
        len(provider_signals) >= 2
        and provider_shares["YES_CAMP"] >= BULLPEN_PROVIDER_SHARE_THRESHOLD
        and provider_shares["NO_CAMP"] >= BULLPEN_PROVIDER_SHARE_THRESHOLD
    )
    high_disagreement = model_two_sided_support or provider_two_sided_support
    median_direction = _classify_direction(median_yes)
    trimmed_mean_direction = _classify_direction(trimmed_mean_yes)
    strong_consensus_direction = (
        median_direction
        if median_direction == trimmed_mean_direction and median_direction != "UNCERTAIN"
        else None
    )
    outlier_count = _count_outlier_models(model_signals, median_yes, iqr_yes)
    opposing_provider_share = (
        provider_shares["NO_CAMP"]
        if strong_consensus_direction == "YES_CAMP"
        else provider_shares["YES_CAMP"]
        if strong_consensus_direction == "NO_CAMP"
        else 0.0
    )
    majority_provider_share = (
        provider_shares["YES_CAMP"]
        if strong_consensus_direction == "YES_CAMP"
        else provider_shares["NO_CAMP"]
        if strong_consensus_direction == "NO_CAMP"
        else 0.0
    )
    consensus_with_outlier = (
        not high_disagreement
        and spread_yes is not None
        and spread_yes > BULLPEN_HIGH_RAW_SPREAD_THRESHOLD
        and strong_consensus_direction is not None
        and majority_provider_share >= 0.6
        and opposing_provider_share < BULLPEN_PROVIDER_SHARE_THRESHOLD
        and 1 <= outlier_count <= 2
    )
    mostly_consensus_some_uncertainty = (
        not high_disagreement
        and not consensus_with_outlier
        and strong_consensus_direction is not None
        and (
            model_counts["UNCERTAIN"] > 0
            or provider_shares["UNCERTAIN"] > 0
        )
        and opposing_provider_share < BULLPEN_PROVIDER_SHARE_THRESHOLD
    )
    disagreement_level = (
        "High"
        if high_disagreement
        else "Medium"
        if consensus_with_outlier or mostly_consensus_some_uncertainty
        else "Low"
    )
    disagreement_category = (
        "HIGH_DISAGREEMENT"
        if high_disagreement
        else "CONSENSUS_WITH_OUTLIER"
        if consensus_with_outlier
        else "MOSTLY_CONSENSUS_SOME_UNCERTAINTY"
        if mostly_consensus_some_uncertainty
        else "CONSENSUS"
    )
    consensus_method = (
        "median"
        if high_disagreement
        else "trimmedMean"
        if len(consensus_yes_values) >= 5 and trimmed_mean_yes is not None
        else "median"
        if median_yes is not None
        else "average"
    )
    fair_yes = (
        trimmed_mean_yes
        if consensus_method == "trimmedMean"
        else median_yes
        if consensus_method == "median"
        else average_yes
    )
    fair_yes, fair_no = _normalize_odds_pair(
        fair_yes,
        None if fair_yes is None else 100 - fair_yes,
    )
    rationale_mismatch_count = len(
        [signal for signal in model_signals if signal.rationale_odds_mismatch]
    )
    confidence = _pick_consensus_label(
        [
            normalize_auto_live_confidence(output.confidence)
            if output.confidence is not None
            else None
            for output in outputs
            if output.error is None
        ],
        tie_breaker="Low",
        rank_map=CONFIDENCE_RANK,
    )
    evidence_status = _pick_consensus_label(
        [
            normalize_auto_live_evidence_status(output.evidence_status)
            if output.evidence_status is not None
            else None
            for output in outputs
            if output.error is None
        ],
        tie_breaker="Low",
        rank_map=EVIDENCE_RANK,
    )
    event_state = _pick_consensus_label(
        [output.event_state for output in outputs if output.error is None],
        tie_breaker="conflicting",
    )

    return outputs, LlmConsensus(
        fair_yes_probability_pct=fair_yes,
        fair_no_probability_pct=fair_no,
        average_yes=average_yes,
        median_yes=median_yes,
        trimmed_mean_yes=trimmed_mean_yes,
        iqr_yes=iqr_yes,
        trimmed_range_yes=trimmed_range_yes,
        min_yes=min_yes,
        max_yes=max_yes,
        spread_yes=spread_yes,
        disagreement_level=disagreement_level,
        disagreement_category=disagreement_category,
        adjudication_required=high_disagreement,
        consensus_method=consensus_method,
        rationale_mismatch_count=rationale_mismatch_count,
        confidence=confidence,
        evidence_status=evidence_status,
        event_state=event_state,
        provider_error_rate=provider_error_rate,
    )
