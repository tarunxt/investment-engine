"""Bullpen 008 P0 deterministic loss-prevention controls.

This module is deliberately provider-independent.  Provider output may add risk or
semantic links, but every fail-closed classification, cap, evidence gate, exit
policy and trigger is reproducible from the frozen input packet.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta
import hashlib
import json
import math
import re
from urllib.parse import urlparse

from app.domains.bullpen008.schemas import Bullpen008Settings

RISK_CLASSIFIER_VERSION = "bullpen008-tail-risk-v1"
SCENARIO_GRAPH_VERSION = "bullpen008-joint-loss-v1"
EVIDENCE_POLICY_VERSION = "bullpen008-evidence-v1"
UNCERTAINTY_POLICY_VERSION = "bullpen008-uncertainty-v1"
EXIT_POLICY_VERSION = "bullpen008-contingent-exit-v1"
DRAWDOWN_POLICY_VERSION = "bullpen008-drawdown-v1"

RISK_TIER_ORDER = {
    "standard_objective": 0,
    "high_shock_geopolitical": 1,
    "single_day_high_shock": 2,
}

_GEO_CONTEXT = re.compile(
    r"\b(?:geopolitic(?:al)?|military|armed forces?|army|navy|air force|"
    r"government|state|country|border|territor(?:y|ial)|iran|israel|gaza|"
    r"jordan|saudi|arab(?: country| state|ian)?|iraq|syria|lebanon|yemen|"
    r"russia|ukraine|china|taiwan|north korea|south korea|nato|hormuz)\b",
    re.I,
)
_STRONG_GEO_CONTEXT = re.compile(
    r"\b(?:geopolitic(?:al)?|military|armed forces?|army|navy|air force|iran|"
    r"israel|gaza|jordan|saudi|iraq|syria|lebanon|yemen|russia|ukraine|"
    r"china|taiwan|north korea|south korea|nato|hormuz)\b",
    re.I,
)
_SHOCK_ACTION = re.compile(
    r"\b(?:military action|attacks?|targets?|strikes?|airstrikes?|missiles?|"
    r"drones?|retaliat(?:e|es|ed|ion)|wars?|invasions?|ceasefire(?: breach)?|"
    r"terror(?:ist)? attacks?|bomb(?:ing|s|ed)?|blockades?|armed clashes?|"
    r"naval action|troop entry|nuclear attacks?|military response)\b",
    re.I,
)
_EXACT_DATE_ON = re.compile(
    r"\bon\s+(?:january|february|march|april|may|june|july|august|"
    r"september|october|november|december)\s+\d{1,2}(?:,?\s+20\d{2})?\b|"
    r"\bon\s+20\d{2}-\d{2}-\d{2}\b",
    re.I,
)
_REGIME_CHANGE = re.compile(
    r"\b(?:new (?:military )?strike|launched? (?:a )?(?:missile|drone|attack)|"
    r"retaliat(?:ed|ion)|ceasefire (?:breach|violat(?:ed|ion))|confirmed (?:an )?attack|"
    r"imminent retaliation|state of emergency|airstrike|bombing|troops? entered|"
    r"naval blockade|hostilities resumed)\b",
    re.I,
)
_IRAN_THEATER = re.compile(r"\biran(?:ian)?\b", re.I)
_IRAN_ESCALATION_LINK = re.compile(
    r"\b(?:arab(?: country| state)?|jordan|saudi|iraq|syria|lebanon|yemen|"
    r"ceasefire|hormuz|blockade|peace deal|retaliat|military|attack|target|strike)\b",
    re.I,
)


def _canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def stable_hash(value: object) -> str:
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _text(value: object) -> str:
    return str(value or "").strip()


def _number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        result = float(str(value).replace("%", "").replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _time(value: object) -> datetime | None:
    if isinstance(value, datetime):
        result = value
    elif isinstance(value, str) and value.strip():
        try:
            result = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    if result.tzinfo is None:
        result = result.replace(tzinfo=UTC)
    return result.astimezone(UTC)


def _full_text(row: dict[str, object]) -> str:
    tags = row.get("tags") if isinstance(row.get("tags"), list) else []
    return " ".join(
        _text(value)
        for value in (
            row.get("question"),
            row.get("slug"),
            row.get("category"),
            row.get("resolution_rules") or row.get("rules") or row.get("description"),
            " ".join(_text(tag) for tag in tags),
        )
        if _text(value)
    )


def stricter_tier(left: str | None, right: str | None) -> str:
    values = [value for value in (left, right) if value in RISK_TIER_ORDER]
    return max(values, key=lambda value: RISK_TIER_ORDER[value]) if values else "standard_objective"


def tier_caps(tier: str, settings: Bullpen008Settings) -> dict[str, float]:
    if tier == "single_day_high_shock":
        value = settings.single_day_high_shock_cap_usd
    elif tier == "high_shock_geopolitical":
        value = settings.high_shock_cluster_cap_usd
    else:
        value = settings.standard_cluster_cap_usd
    return {
        "contract_cap_usd": min(value, settings.max_contract_exposure_usd),
        "cluster_cap_usd": min(value, settings.max_strict_cluster_exposure_usd, settings.max_common_catalyst_exposure_usd),
        "scenario_cap_usd": min(
            value,
            settings.max_contract_exposure_usd,
            settings.max_strict_cluster_exposure_usd,
            settings.max_common_catalyst_exposure_usd,
        ),
    }


def classify_tail_risk(
    row: dict[str, object],
    *,
    settings: Bullpen008Settings,
    now: datetime,
    llm_tier: str | None = None,
) -> dict[str, object]:
    """Classify bounded military/geopolitical contracts and fail closed."""

    text = _full_text(row)
    rules = _text(row.get("resolution_rules") or row.get("rules") or row.get("description"))
    start = _time(row.get("start_time") or row.get("startDate") or row.get("event_start"))
    end = _time(row.get("end_time") or row.get("deadline") or row.get("close_time"))
    window_hours = (
        max(0.0, (end - start).total_seconds() / 3600)
        if start is not None and end is not None
        else _number(row.get("resolution_window_hours"))
    )
    remaining_hours = (end - now).total_seconds() / 3600 if end else None
    geo_matches = sorted({match.group(0).lower() for match in _GEO_CONTEXT.finditer(text)})
    action_matches = sorted({match.group(0).lower() for match in _SHOCK_ACTION.finditer(text)})
    geo_spans = [match.span() for match in _GEO_CONTEXT.finditer(text)]
    action_spans = [match.span() for match in _SHOCK_ACTION.finditer(text)]
    bounded_context = any(
        min(abs(left[0] - right[1]), abs(right[0] - left[1])) <= 100
        for left in geo_spans
        for right in action_spans
    )
    category_context = bool(
        re.search(r"\b(?:geopolitics?|military|defen[cs]e|international relations)\b", _text(row.get("category")), re.I)
    )
    is_high_shock = bool(
        action_matches
        and geo_matches
        and (_STRONG_GEO_CONTEXT.search(text) or category_context or bounded_context)
    )
    exact_day = bool(_EXACT_DATE_ON.search(_text(row.get("question")) + " " + _text(row.get("slug"))))
    single_day = bool(is_high_shock and (exact_day or (window_hours is not None and window_hours <= 24)))
    deterministic_tier = (
        "single_day_high_shock"
        if single_day
        else "high_shock_geopolitical"
        if is_high_shock
        else "standard_objective"
    )
    effective_tier = stricter_tier(deterministic_tier, llm_tier)
    codes: list[str] = []
    if single_day and settings.hard_reject_single_day_geopolitical:
        codes.append("SINGLE_DAY_HIGH_SHOCK")
    if is_high_shock and remaining_hours is not None and remaining_hours < settings.geopolitical_min_entry_hours:
        codes.append("HIGH_SHOCK_ENTRY_WINDOW_LT_48H")
    if is_high_shock and end is None:
        codes.append("HIGH_SHOCK_TIMING_UNRESOLVED")
    if is_high_shock and (not rules or len(rules) < 20):
        codes.append("HIGH_SHOCK_RULES_INCOMPLETE")
    # A question that plainly says "on <date>" supplies a one-day window even
    # when Gamma does not expose an explicit start timestamp.
    timing_authority = "question_exact_date" if exact_day else "parsed_start_end" if window_hours is not None else "deadline_only"
    evidence = {
        "classifier_version": RISK_CLASSIFIER_VERSION,
        "geopolitical_context_matches": geo_matches,
        "high_shock_action_matches": action_matches,
        "bounded_geopolitical_action_context": bounded_context,
        "category_context": category_context,
        "exact_calendar_date_match": exact_day,
        "parsed_start_time": start.isoformat() if start else None,
        "parsed_end_time": end.isoformat() if end else None,
        "resolution_window_hours": round(window_hours, 4) if window_hours is not None else (24.0 if exact_day else None),
        "remaining_hours": round(remaining_hours, 4) if remaining_hours is not None else None,
        "timing_authority": timing_authority,
        "rules_complete": bool(rules and len(rules) >= 20),
    }
    return {
        "classifier_version": RISK_CLASSIFIER_VERSION,
        "deterministic_risk_tier": deterministic_tier,
        "llm_risk_tier": llm_tier if llm_tier in RISK_TIER_ORDER else None,
        "risk_tier": effective_tier,
        "risk_classification_evidence": evidence,
        "risk_rejection_codes": list(dict.fromkeys(codes)),
        "is_high_shock_geopolitical": is_high_shock,
        "is_single_day_high_shock": single_day,
        **tier_caps(effective_tier, settings),
    }


def normalize_evidence_packet(packet: object) -> dict[str, object]:
    source_packet = packet if isinstance(packet, dict) else {}
    rows = source_packet.get("sources") if isinstance(source_packet.get("sources"), list) else []
    sources: list[dict[str, object]] = []
    for index, raw in enumerate(rows):
        if not isinstance(raw, dict):
            continue
        url = _text(raw.get("url"))
        publisher = _text(raw.get("publisher") or raw.get("domain") or urlparse(url).netloc).lower()
        extracted_claims = raw.get("extracted_claims") if isinstance(raw.get("extracted_claims"), list) else []
        proposition = _text(
            raw.get("short_extracted_proposition")
            or raw.get("summary")
            or raw.get("content")
            or raw.get("snippet")
            or (extracted_claims[0] if extracted_claims else None)
        )[:600]
        source = {
            "source_id": _text(raw.get("source_id")) or f"S{index + 1}",
            "publisher": publisher,
            "url": url,
            "title": _text(raw.get("title")),
            "published_at": raw.get("published_at") or raw.get("published_date"),
            "fetched_at": raw.get("fetched_at") or source_packet.get("built_at_utc"),
            "source_type": _text(raw.get("source_type")) or "unknown",
            "short_extracted_proposition": proposition,
            "content_hash": _text(raw.get("content_hash") or raw.get("content_fingerprint") or raw.get("fingerprint")) or stable_hash({"url": url, "title": raw.get("title"), "proposition": proposition}),
            "entity_coverage": raw.get("entity_coverage") if isinstance(raw.get("entity_coverage"), list) else (["question_entities"] if raw.get("entity_match") else []),
            "relevance": _number(raw.get("relevance") or raw.get("relevance_score")) or 0,
            "thesis_effect": _text(raw.get("thesis_effect")) or "unknown",
            "social_media_only": bool(raw.get("social_media_only")),
        }
        sources.append(source)
    return {
        "packet_version": EVIDENCE_POLICY_VERSION,
        "built_at_utc": source_packet.get("built_at_utc"),
        "sources": sources,
        "conflict_status": _text(source_packet.get("conflict_status")) or "none",
        "adjudication_status": _text(source_packet.get("adjudication_status")) or "resolved",
        "retrieval_error": source_packet.get("retrieval_error"),
        "packet_hash": stable_hash(sources),
    }


def validate_evidence_packet(
    packet: object,
    *,
    risk_tier: str,
    settings: Bullpen008Settings,
    now: datetime,
) -> dict[str, object]:
    normalized = normalize_evidence_packet(packet)
    if risk_tier == "standard_objective":
        return {**normalized, "evidence_complete": True, "evidence_blocker_codes": [], "fresh_source_count": len(normalized["sources"])}
    blockers: list[str] = []
    sources = [row for row in normalized["sources"] if isinstance(row, dict)]
    if normalized.get("retrieval_error"):
        blockers.append("EVIDENCE_RETRIEVAL_FAILED")
    if not sources:
        blockers.append("EVIDENCE_EMPTY")
    credible = [
        row
        for row in sources
        if row.get("publisher")
        and row.get("source_type") not in {"unknown", "aggregator", "generic_landing_page", "social_media"}
        and not row.get("social_media_only")
        and float(row.get("relevance") or 0) >= 0.4
    ]
    publishers = {str(row.get("publisher")) for row in credible}
    if len(publishers) < settings.high_shock_min_source_count:
        blockers.append("EVIDENCE_INDEPENDENT_SOURCE_COUNT_LT_2")
    fresh = []
    timestamps_missing = False
    for row in credible:
        published = _time(row.get("published_at"))
        fetched = _time(row.get("fetched_at"))
        if published is None or fetched is None:
            timestamps_missing = True
            continue
        if 0 <= (now - published).total_seconds() <= settings.high_shock_evidence_max_age_minutes * 60:
            fresh.append(row)
    if timestamps_missing:
        blockers.append("EVIDENCE_TIMESTAMP_MISSING")
    if not fresh:
        blockers.append("EVIDENCE_STALE")
    if normalized.get("conflict_status") == "material" and normalized.get("adjudication_status") != "resolved":
        blockers.append("EVIDENCE_CONFLICT_UNRESOLVED")
    return {
        **normalized,
        "credible_source_count": len(credible),
        "independent_publisher_count": len(publishers),
        "fresh_source_count": len(fresh),
        "evidence_complete": not blockers,
        "evidence_blocker_codes": list(dict.fromkeys(blockers)),
    }


def reward_and_edge_protection(
    row: dict[str, object],
    *,
    settings: Bullpen008Settings,
    now: datetime,
) -> dict[str, object]:
    price = _number(row.get("current_chosen_side_bullpen_odds"))
    allocation = _number(row.get("proposed_allocation_usd")) or settings.allocation_increment_usd
    raw_probability = _number(row.get("chosen_side_llm_probability"))
    confidence = _text(row.get("confidence"))
    evidence_quality = _text(row.get("evidence_quality"))
    components = row.get("risk_components") if isinstance(row.get("risk_components"), dict) else {}
    tier = _text(row.get("risk_tier")) or "standard_objective"
    disagreement = _text(row.get("llm_disagreement_level")).lower()
    rejection_codes: list[str] = []
    quantity = maximum_payout = maximum_profit = maximum_loss = reward_ratio = loss_ratio = None
    if price is None or price <= 0 or price >= 100 or allocation <= 0:
        rejection_codes.append("ENTRY_PRICE_INVALID")
    else:
        quantity = allocation * 100 / price
        maximum_payout = quantity
        maximum_profit = maximum_payout - allocation
        maximum_loss = allocation
        reward_ratio = maximum_profit / maximum_loss if maximum_loss > 0 else None
        loss_ratio = maximum_loss / maximum_profit if maximum_profit > 0 else None
        if price > settings.entry_price_hard_ceiling_pct:
            rejection_codes.append("ENTRY_PRICE_ABOVE_95")
        elif price >= settings.entry_price_high_zone_pct and allocation > settings.high_zone_max_allocation_usd:
            rejection_codes.append("HIGH_PRICE_ALLOCATION_ABOVE_5")
        if reward_ratio is None or reward_ratio < settings.min_reward_to_loss_ratio:
            rejection_codes.append("REWARD_TO_LOSS_BELOW_MINIMUM")
    missing_uncertainty = (
        raw_probability is None
        or confidence not in {"Low", "Medium", "High"}
        or evidence_quality not in {"Low", "Moderate", "Strong"}
        or not all(key in components and _number(components.get(key)) is not None for key in ("U", "A", "T", "D", "I"))
    )
    if missing_uncertainty:
        rejection_codes.append("UNCERTAINTY_INPUTS_MISSING")
    if evidence_quality == "Low":
        rejection_codes.append("EVIDENCE_QUALITY_LOW")
    if disagreement == "high":
        rejection_codes.append("MODEL_DISAGREEMENT_HIGH")
    evidence_penalty = {"Strong": 1.0, "Moderate": 4.0, "Low": 9.0}.get(evidence_quality, 10.0)
    confidence_penalty = {"High": 1.0, "Medium": 3.0, "Low": 7.0}.get(confidence, 10.0)
    disagreement_penalty = 10.0 if disagreement == "high" else 4.0 if disagreement == "medium" else 0.0
    structural_penalty = min(5.0, (_number(row.get("risk_score")) or 10.0) * 0.5)
    data_penalty = min(4.0, (_number(components.get("D")) or 10.0) * 0.4)
    shock_penalty = min(4.0, (_number(components.get("I")) or 10.0) * 0.4)
    tier_penalty = 4.0 if tier == "single_day_high_shock" else 2.0 if tier == "high_shock_geopolitical" else 0.0
    calibration_penalty = max(0.0, _number(row.get("historical_calibration_error_pp")) or 0.0)
    haircut = round(evidence_penalty + confidence_penalty + disagreement_penalty + structural_penalty + data_penalty + shock_penalty + tier_penalty + calibration_penalty, 2)
    conservative_probability = round(max(0.0, (raw_probability or 0.0) - haircut), 2) if not missing_uncertainty else None
    conservative_edge = round(conservative_probability - price, 2) if conservative_probability is not None and price is not None else None
    minimum_edge = settings.high_shock_conservative_edge_min_pp if tier != "standard_objective" else settings.conservative_edge_min_pp
    if conservative_edge is None or conservative_edge < minimum_edge:
        rejection_codes.append("CONSERVATIVE_EDGE_BELOW_MINIMUM")
    evidence = validate_evidence_packet(row.get("evidence_packet"), risk_tier=tier, settings=settings, now=now)
    rejection_codes.extend(evidence["evidence_blocker_codes"])
    return {
        "raw_llm_probability": raw_probability,
        "uncertainty_haircut_pp": haircut,
        "uncertainty_policy_version": UNCERTAINTY_POLICY_VERSION,
        "conservative_probability": conservative_probability,
        "market_probability": price,
        "raw_edge_pp": round(raw_probability - price, 2) if raw_probability is not None and price is not None else None,
        "conservative_edge_pp": conservative_edge,
        "minimum_conservative_edge_pp": minimum_edge,
        "entry_allocation_tested_usd": allocation,
        "quantity_shares": round(quantity, 6) if quantity is not None else None,
        "maximum_payout_usd": round(maximum_payout, 2) if maximum_payout is not None else None,
        "maximum_profit_usd": round(maximum_profit, 2) if maximum_profit is not None else None,
        "maximum_loss_usd": round(maximum_loss, 2) if maximum_loss is not None else None,
        "reward_to_loss_ratio": round(reward_ratio, 4) if reward_ratio is not None else None,
        "loss_to_reward_ratio": round(loss_ratio, 4) if loss_ratio is not None else None,
        "evidence_validation": evidence,
        "entry_rejection_codes": list(dict.fromkeys(rejection_codes)),
        "entry_protection_passed": not rejection_codes,
    }


def detect_regime_change(row: dict[str, object]) -> dict[str, object]:
    packet = normalize_evidence_packet(row.get("evidence_packet"))
    matches: list[dict[str, object]] = []
    side = _text(row.get("chosen_side") or (row.get("held_sides") or [""])[0]).upper()
    question = _text(row.get("question")).lower()
    for source in packet["sources"]:
        if not isinstance(source, dict):
            continue
        proposition = _text(source.get("short_extracted_proposition"))
        match = _REGIME_CHANGE.search(proposition)
        if not match:
            continue
        invalidates = (
            (side == "YES" and "ceasefire" in question)
            or (side == "NO" and bool(_SHOCK_ACTION.search(question)))
            or source.get("thesis_effect") == "invalidates"
        )
        if invalidates:
            matches.append({"source_id": source.get("source_id"), "publisher": source.get("publisher"), "matched_text": match.group(0), "content_hash": source.get("content_hash")})
    return {
        "regime_change_active": bool(matches),
        "regime_change_reason": "VERIFIED_ESCALATION_INVALIDATES_HELD_THESIS" if matches else None,
        "regime_change_evidence": matches,
        "episode_hash": stable_hash(matches) if matches else None,
    }


def _scenario_key(row: dict[str, object]) -> tuple[str, str, list[str], list[str]]:
    text = _full_text(row)
    market_id = _text(row.get("market_id"))
    deterministic: list[str] = []
    semantic: list[str] = []
    if _IRAN_THEATER.search(text) and _IRAN_ESCALATION_LINK.search(text):
        deterministic.append("IRAN_ENTITY_AND_REGIONAL_ESCALATION_RULES")
        return ("iran-regional-escalation", "Iranian regional military escalation or ceasefire breakdown", deterministic, semantic)
    common = _text(row.get("common_catalyst_cluster_id"))
    if common:
        semantic.append("STAGE3_COMMON_CATALYST_SEMANTIC_LINK")
        return (common, _text(row.get("driver") or row.get("main_joint_loss_trigger")) or common, deterministic, semantic)
    return (f"market:{market_id}", _text(row.get("question")) or market_id, deterministic, semantic)


def _loss_direction(row: dict[str, object], driver: str) -> tuple[str, str]:
    side = _text(row.get("chosen_side") or (row.get("held_sides") or [""])[0]).upper()
    question = _text(row.get("question"))
    lower = question.lower()
    if "ceasefire" in lower and side == "YES":
        return ("YES_LOSES", "A verified escalation or ceasefire breach makes the held YES continuation thesis lose.")
    if side == "NO" and _SHOCK_ACTION.search(lower):
        return ("NO_LOSES", "The shared escalation event satisfies the prohibited military-action condition, so the held NO side loses.")
    return (f"{side or 'CHOSEN'}_LOSES", f"The scenario driver ({driver}) is the adverse development for the recorded chosen side.")


def build_joint_loss_scenarios(
    rows: list[dict[str, object]],
    *,
    settings: Bullpen008Settings,
) -> dict[str, object]:
    groups: dict[str, list[tuple[dict[str, object], str, list[str], list[str]]]] = defaultdict(list)
    descriptions: dict[str, str] = {}
    for row in rows:
        key, driver, deterministic, semantic = _scenario_key(row)
        groups[key].append((row, driver, deterministic, semantic))
        descriptions[key] = driver
    scenarios: list[dict[str, object]] = []
    membership_by_market: dict[str, list[str]] = defaultdict(list)
    for key, members in sorted(groups.items()):
        market_ids = sorted({_text(row.get("market_id")) for row, *_ in members if row.get("market_id")})
        scenario_id = "scenario:" + stable_hash({"version": SCENARIO_GRAPH_VERSION, "key": key, "markets": market_ids})[:20]
        tiers = [_text(row.get("risk_tier")) or "standard_objective" for row, *_ in members]
        tier = max(tiers, key=lambda value: RISK_TIER_ORDER.get(value, 0))
        cap = tier_caps(tier, settings)["scenario_cap_usd"]
        directions: dict[str, dict[str, str]] = {}
        deterministic_links: list[str] = []
        semantic_links: list[str] = []
        existing = pending = target = 0.0
        adjudication_status = "resolved"
        adjudication_reasons: list[str] = []
        source_evidence: list[dict[str, object]] = []
        for row, driver, deterministic, semantic in members:
            market_id = _text(row.get("market_id"))
            direction, reason = _loss_direction(row, driver)
            directions[market_id] = {"direction": direction, "reason": reason, "chosen_side": _text(row.get("chosen_side"))}
            deterministic_links.extend(deterministic)
            semantic_links.extend(semantic)
            existing += float(_number(row.get("existing_exposure_usd")) or 0)
            pending += float(_number(row.get("pending_exposure_usd")) or 0)
            target += float(_number(row.get("target_exposure_usd")) or 0)
            if row.get("adjudication_status") != "resolved":
                adjudication_status = "unresolved"
            adjudication_reasons.append(_text(row.get("adjudication_reason")))
            packet = normalize_evidence_packet(row.get("evidence_packet"))
            source_evidence.extend(packet["sources"][:2])
            membership_by_market[market_id].append(scenario_id)
        scenarios.append({
            "scenario_id": scenario_id,
            "scenario_version": SCENARIO_GRAPH_VERSION,
            "driver": descriptions[key],
            "description": f"Joint gross-loss scenario for {len(market_ids)} position(s): {descriptions[key]}.",
            "affected_market_ids": market_ids,
            "loss_direction_by_market": directions,
            "main_joint_loss_trigger": descriptions[key],
            "deterministic_links": sorted(set(deterministic_links)),
            "semantic_links": sorted(set(semantic_links)),
            "source_evidence": source_evidence,
            "adjudication_status": adjudication_status,
            "adjudication_reason": "; ".join(value for value in adjudication_reasons if value) or "All memberships and loss directions were deterministically or semantically adjudicated.",
            "risk_tier": tier,
            "existing_loss_at_risk_usd": round(existing, 2),
            "pending_loss_at_risk_usd": round(pending, 2),
            "target_loss_at_risk_usd": round(target, 2),
            "effective_scenario_cap_usd": cap,
        })
    augmented: list[dict[str, object]] = []
    scenario_by_id = {str(row["scenario_id"]): row for row in scenarios}
    for row in rows:
        market_id = _text(row.get("market_id"))
        scenario_ids = sorted(set(membership_by_market.get(market_id, [])))
        caps = [float(scenario_by_id[value]["effective_scenario_cap_usd"]) for value in scenario_ids]
        augmented.append({**row, "joint_loss_scenario_ids": scenario_ids, "effective_joint_scenario_cap_usd": min(caps) if caps else settings.standard_cluster_cap_usd})
    unresolved = [row for row in scenarios if row["adjudication_status"] != "resolved" or any(not value.get("reason") for value in row["loss_direction_by_market"].values())]
    return {
        "rows": augmented,
        "scenarios": scenarios,
        "unresolved_scenarios": unresolved,
        "scenario_graph_version": SCENARIO_GRAPH_VERSION,
        "pass_condition_met": not unresolved and all(membership_by_market.get(_text(row.get("market_id"))) for row in rows),
    }


def certify_exit_policies(
    rows: list[dict[str, object]],
    *,
    settings: Bullpen008Settings,
    now: datetime,
) -> dict[str, object]:
    policies: list[dict[str, object]] = []
    mandatory_exit_markets: set[str] = set()
    for row in rows:
        if not row.get("active_position") or float(_number(row.get("current_exposure_usd")) or 0) <= 0:
            continue
        tier = _text(row.get("risk_tier")) or "standard_objective"
        if tier == "standard_objective":
            continue
        deadline = _time(row.get("deadline") or row.get("close_time"))
        days = _number(row.get("days_until_close"))
        if deadline is None or (days is not None and days <= 0):
            continue
        window = settings.single_day_time_exit_hours if tier == "single_day_high_shock" else settings.high_shock_time_exit_hours
        must_exit_by = deadline - timedelta(hours=window)
        odds = _number(row.get("current_chosen_side_bullpen_odds"))
        reward_ratio = _number(row.get("reward_to_loss_ratio"))
        reasons = ["HIGH_SHOCK_MANDATORY_TIME_EXIT"]
        if odds is not None and odds >= settings.take_profit_odds_floor_pct:
            reasons.append("TAKE_PROFIT_ODDS_REACHED")
        if reward_ratio is not None and reward_ratio < settings.min_reward_to_loss_ratio:
            reasons.append("REWARD_TO_LOSS_BELOW_MINIMUM")
        mandatory_now = must_exit_by <= now or "TAKE_PROFIT_ODDS_REACHED" in reasons or "REWARD_TO_LOSS_BELOW_MINIMUM" in reasons
        market_id = _text(row.get("market_id"))
        if mandatory_now:
            mandatory_exit_markets.add(market_id)
        exposure = float(_number(row.get("current_exposure_usd")) or 0)
        max_shares = exposure * 100 / odds if odds and odds > 0 else 0
        base = {
            "affected_market_id": market_id,
            "affected_scenario_ids": list(row.get("joint_loss_scenario_ids") or []),
            "must_exit_by": must_exit_by.isoformat(),
            "time_exit_window_hours": window,
            "take_profit_odds_floor_pct": settings.take_profit_odds_floor_pct,
            "minimum_reward_to_loss_ratio": settings.min_reward_to_loss_ratio,
            "reason_codes": reasons,
            "maximum_permitted_post_exit_exposure": 0.0,
            "policy_version": EXIT_POLICY_VERSION,
            "trigger_type": "MULTI_TRIGGER_CONTINGENT_EXIT",
            "thresholds": {
                "held_side_odds_below_pct": settings.contingent_exit_odds_floor_pct,
                "odds_drop_15m_pp": settings.odds_drop_15m_pp,
                "odds_drop_24h_pp": settings.odds_drop_24h_pp,
                "catastrophic_drop_15m_pp": settings.catastrophic_drop_15m_pp,
                "mandatory_time_exit": must_exit_by.isoformat(),
                "minimum_reward_to_loss_ratio": settings.min_reward_to_loss_ratio,
            },
            "observation_window": {"fast_minutes": 15, "slow_hours": 24},
            "confirmation_requirements": settings.quote_confirmation_count,
            "activation_expiry": deadline.isoformat(),
            "permitted_action": "full_exit",
            "maximum_sell_quantity": round(max_shares, 6),
            "minimum_acceptable_price": round(max(0, (odds or 0) - settings.max_slippage_cents), 2),
            "maximum_slippage": settings.max_slippage_cents,
            "maximum_spread": settings.max_spread_cents,
            "retry_policy": {"mode": "recoverable_limit_only", "max_attempts": 5, "never_market_order": True},
            "mandatory_exit_active": mandatory_now,
        }
        base["policy_hash"] = stable_hash(base)
        policies.append(base)
    return {"policies": policies, "mandatory_exit_market_ids": sorted(mandatory_exit_markets), "policy_version": EXIT_POLICY_VERSION}


def evaluate_contingent_policy(
    policy: dict[str, object],
    observations: list[dict[str, object]],
    *,
    now: datetime,
    regime_change_active: bool = False,
    hard_drawdown_active: bool = False,
) -> dict[str, object]:
    valid_hash = _text(policy.get("policy_hash")) == stable_hash({key: value for key, value in policy.items() if key != "policy_hash"})
    ordered = sorted(observations, key=lambda row: _time(row.get("observed_at")) or datetime.min.replace(tzinfo=UTC))
    latest = ordered[-1] if ordered else {}
    latest_odds = _number(latest.get("held_side_odds"))
    thresholds = policy.get("thresholds") if isinstance(policy.get("thresholds"), dict) else {}
    triggers: list[str] = []
    if latest_odds is not None and latest_odds < float(thresholds.get("held_side_odds_below_pct") or 85):
        triggers.append("HELD_SIDE_ODDS_BELOW_FLOOR")
    reward_ratio = ((100 / latest_odds) - 1) if latest_odds is not None and 0 < latest_odds < 100 else None
    if reward_ratio is not None and reward_ratio < float(thresholds.get("minimum_reward_to_loss_ratio") or 0.10):
        triggers.append("REWARD_TO_LOSS_BELOW_MINIMUM")
    recent_15 = [row for row in ordered if (stamp := _time(row.get("observed_at"))) and now - stamp <= timedelta(minutes=15)]
    recent_24 = [row for row in ordered if (stamp := _time(row.get("observed_at"))) and now - stamp <= timedelta(hours=24)]
    drop_15 = max([float(_number(row.get("held_side_odds")) or 0) for row in recent_15], default=latest_odds or 0) - (latest_odds or 0)
    drop_24 = max([float(_number(row.get("held_side_odds")) or 0) for row in recent_24], default=latest_odds or 0) - (latest_odds or 0)
    catastrophic = drop_15 > float(thresholds.get("catastrophic_drop_15m_pp") or 20)
    if drop_15 >= float(thresholds.get("odds_drop_15m_pp") or 5):
        triggers.append("ODDS_DROP_15M")
    if drop_24 >= float(thresholds.get("odds_drop_24h_pp") or 10):
        triggers.append("ODDS_DROP_24H")
    must_exit = _time(thresholds.get("mandatory_time_exit"))
    if must_exit and now >= must_exit:
        triggers.append("MANDATORY_TIME_EXIT")
    if regime_change_active:
        triggers.append("REGIME_CHANGE")
    if hard_drawdown_active:
        triggers.append("HARD_PORTFOLIO_DRAWDOWN")
    confirmation_count = int(policy.get("confirmation_requirements") or 2)
    confirmed_quotes = len(recent_15) >= confirmation_count and all(
        _number(row.get("held_side_odds")) is not None
        and float(_number(row.get("held_side_odds")) or 100) < float(thresholds.get("held_side_odds_below_pct") or 85)
        for row in recent_15[-confirmation_count:]
    )
    immediate = catastrophic or regime_change_active
    drop_confirmed = (
        ("ODDS_DROP_15M" in triggers and len(recent_15) >= confirmation_count)
        or ("ODDS_DROP_24H" in triggers and len(recent_24) >= confirmation_count)
    )
    proven = bool(triggers) and (
        immediate
        or confirmed_quotes
        or drop_confirmed
        or any(value in triggers for value in ("MANDATORY_TIME_EXIT", "HARD_PORTFOLIO_DRAWDOWN"))
    )
    blockers = []
    if not valid_hash:
        blockers.append("INVALID_POLICY_HASH")
    if not observations:
        blockers.append("FRESH_QUOTE_MISSING")
    latest_timestamp = _time(latest.get("observed_at"))
    if latest_timestamp is not None and now - latest_timestamp > timedelta(minutes=2):
        blockers.append("FRESH_QUOTE_MISSING")
    activation_expiry = _time(policy.get("activation_expiry"))
    if activation_expiry is None or now > activation_expiry:
        blockers.append("ACTIVATION_POLICY_EXPIRED")
    if triggers and not proven:
        blockers.append("QUOTE_CONFIRMATION_INCOMPLETE")
    return {
        "policy_hash_valid": valid_hash,
        "trigger_types": list(dict.fromkeys(triggers)),
        "first_quote": recent_15[-confirmation_count].get("held_side_odds") if len(recent_15) >= confirmation_count else None,
        "confirming_quote": latest_odds,
        "drop_15m_pp": round(drop_15, 2),
        "drop_24h_pp": round(drop_24, 2),
        "catastrophic_move": catastrophic,
        "trigger_proven": proven,
        "activation_status": "WOULD_ACTIVATE" if proven and valid_hash else "BLOCKED" if blockers else "DORMANT",
        "submission_status": "WOULD_SUBMIT" if proven and valid_hash else None,
        "blocker_codes": blockers,
    }


def evaluate_drawdown(
    *,
    baseline_equity_usd: float,
    current_equity_usd: float,
    external_flows_usd: float,
    settings: Bullpen008Settings,
) -> dict[str, object]:
    adjusted_current = current_equity_usd - external_flows_usd
    drawdown = max(0.0, baseline_equity_usd - adjusted_current)
    soft = settings.bankroll_usd * settings.soft_drawdown_pct / 100
    hard = settings.bankroll_usd * settings.hard_drawdown_pct / 100
    mode = "EXIT_ONLY_HARD_DRAWDOWN" if drawdown >= hard else "BUY_FREEZE_SOFT_DRAWDOWN" if drawdown >= soft else "NORMAL"
    return {
        "policy_version": DRAWDOWN_POLICY_VERSION,
        "baseline_equity_usd": round(baseline_equity_usd, 2),
        "current_equity_usd": round(current_equity_usd, 2),
        "external_flows_neutralised_usd": round(external_flows_usd, 2),
        "adjusted_current_equity_usd": round(adjusted_current, 2),
        "drawdown_usd": round(drawdown, 2),
        "soft_threshold_usd": round(soft, 2),
        "hard_threshold_usd": round(hard, 2),
        "buy_freeze": drawdown >= soft,
        "exit_only": drawdown >= hard,
        "state": mode,
    }


def build_loss_prevention_audit(allocations: list[dict[str, object]]) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for row in allocations:
        codes = set(str(value) for value in row.get("explanation_codes", []) if value)
        codes.update(str(value) for value in row.get("entry_rejection_codes", []) if value)
        rows.append({
            "market_id": row.get("market_id"),
            "question": row.get("question"),
            "counterfactual_estimate": True,
            "rejected_entry": bool(codes & {"SINGLE_DAY_HIGH_SHOCK", "HIGH_SHOCK_ENTRY_WINDOW_LT_48H", "ENTRY_PRICE_ABOVE_95", "REWARD_TO_LOSS_BELOW_MINIMUM", "CONSERVATIVE_EDGE_BELOW_MINIMUM", "EVIDENCE_EMPTY", "EVIDENCE_STALE"}),
            "reduced_size": "HIGH_PRICE_ALLOCATION_ABOVE_5" in codes or "RISK_TIER_CAP_BINDING" in codes,
            "blocked_top_up": "INFORMATION_SHOCK_ACTIVE" in codes or "SCENARIO_OVER_CAP_BUY_FREEZE" in codes,
            "required_early_exit": bool(row.get("mandatory_exit_active")),
            "contingent_exit_certified": bool(row.get("contingent_exit_policy_hashes")),
            "buy_freeze": "BUY_FREEZE_SOFT_DRAWDOWN" in codes,
            "exit_only": "EXIT_ONLY_HARD_DRAWDOWN" in codes,
            "safeguard_codes": sorted(codes),
            "disclaimer": "Counterfactual estimate only; not actual realised or avoided P&L.",
        })
    return rows
