from __future__ import annotations

import hashlib
import json
import math
import re
from collections import defaultdict
from collections.abc import Iterable
from datetime import UTC, datetime

from app.domains.bullpen008.constants import (
    CLUSTER_MAP_VERSION,
    CLUSTER_PROMPT_VERSION,
    LLM_PROMPT_VERSION,
    OPTIMIZER_VERSION,
    SPEECH_WORDING_TERMS,
)
from app.domains.bullpen008.schemas import Bullpen008Settings
from app.domains.polymarket_auto_live.returns_formula import (
    calculate_returns_per_day_formula,
)

STAGE2_PARSER_VERSION = "bullpen008-stage2-parser-v2"
STAGE3_PARSER_VERSION = "bullpen008-stage3-parser-v2"

_SPORTS_TERMS = (
    " vs ",
    "match",
    "game",
    "tournament",
    "nba",
    "nfl",
    "mlb",
    "nhl",
    "cricket",
    "football",
    "soccer",
    "tennis",
    "ufc",
    "champions league",
    "world cup",
)
_WEATHER_TERMS = (
    "weather",
    "temperature",
    "rainfall",
    "snowfall",
    "hurricane",
    "tornado",
)
_SOCIAL_COUNT_TERMS = (
    "tweet count",
    "tweets",
    "post count",
    "posts on",
)
_RELEASE_BY_TERMS = (
    "release by",
    "released by",
    "launch by",
    "published by",
)
_NARROW_BAND_PATTERN = re.compile(
    r"\b(?:between|from)\s+[-+]?\d[\d,.]*\s+(?:and|to)\s+[-+]?\d[\d,.]*\b|"
    r"\bexactly\s+[-+]?\d[\d,.]*\b|"
    r"\b[-+]?\d[\d,.]*\s*(?:-|–|—)\s*[-+]?\d[\d,.]*\b",
    re.I,
)
_DATE_TOKEN_PATTERN = re.compile(
    r"\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|"
    r"jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|"
    r"dec(?:ember)?)\s+\d{1,2}(?:,?\s+\d{4})?\b|\b20\d{2}-\d{2}-\d{2}\b",
    re.I,
)
_THRESHOLD_TOKEN_PATTERN = re.compile(
    r"\b(?:above|below|over|under|at least|more than|less than|between|from)\b"
    r"(?:\s+[^\s]+){0,4}\s+[-+]?\d[\d,.]*%?",
    re.I,
)


def canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def stable_hash(value: object) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _text(value: object) -> str:
    return str(value or "").strip()


def _lower_text(*values: object) -> str:
    return " ".join(_text(value) for value in values if _text(value)).lower()


def _float(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.replace("%", "").replace(",", "").strip())
        except ValueError:
            return None
    return None


def _parse_datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and value.strip():
        normalized = value.strip().replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(normalized)
        except ValueError:
            if re.fullmatch(r"\d{4}-\d{2}-\d{2}", normalized):
                parsed = datetime.fromisoformat(f"{normalized}T23:59:59+00:00")
            else:
                return None
    else:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _market_id(row: dict[str, object]) -> str:
    return _text(row.get("market_id") or row.get("id") or row.get("slug"))


def _rules(row: dict[str, object]) -> str:
    return _text(
        row.get("resolution_rules") or row.get("rules") or row.get("description")
    )


def _search_text(row: dict[str, object]) -> str:
    return _lower_text(
        row.get("question"),
        row.get("slug"),
        _rules(row),
        row.get("context"),
        row.get("category"),
        " ".join(str(item) for item in row.get("tags", []) if item),
    )


def stage1_rejection_reasons(
    row: dict[str, object],
    *,
    settings: Bullpen008Settings,
    now: datetime,
) -> list[dict[str, object]]:
    reasons: list[dict[str, object]] = []

    def reject(code: str, reason: str, phrase: str | None = None) -> None:
        reasons.append(
            {"code": code, "reason": reason, **({"phrase": phrase} if phrase else {})}
        )

    search_text = _search_text(row)
    is_closed = bool(row.get("closed")) or row.get("open") is False
    is_resolved = bool(row.get("resolved"))
    is_claimable = bool(row.get("claimable"))
    if is_closed:
        reject("CLOSED", "Market is closed and cannot receive a new entry.")
    if is_resolved:
        reject("RESOLVED", "Market is resolved and cannot receive a new entry.")
    if is_claimable:
        reject(
            "CLAIMABLE",
            "Market is claimable and is retained only for settlement processing.",
        )
    if row.get("accepting_orders") is False:
        reject("NOT_ACCEPTING_ORDERS", "Market is not currently accepting new orders.")

    deadline = _parse_datetime(row.get("deadline") or row.get("close_time"))
    if deadline is None:
        reject("MISSING_DEADLINE", "No authoritative deadline could be parsed.")
    elif deadline <= now:
        reject("DEADLINE_PASSED", "The contract deadline has passed.")
    elif (deadline - now).total_seconds() > settings.closing_window_days * 86_400:
        reject(
            "OUTSIDE_CLOSING_WINDOW",
            f"Deadline is outside the saved {settings.closing_window_days}-day window.",
        )

    if not _rules(row):
        reject("MISSING_RESOLUTION_RULES", "Full resolution rules are unavailable.")

    yes_odds = _float(row.get("current_yes_odds"))
    no_odds = _float(row.get("current_no_odds"))
    outcomes = [
        str(value).strip().lower() for value in row.get("outcomes", []) if value
    ]
    if len(set(outcomes)) != 2 or set(outcomes) != {"yes", "no"}:
        reject("NON_BINARY", "Outcomes are not an unambiguous binary YES/NO pair.")
    if yes_odds is None or no_odds is None:
        reject("MISSING_ODDS", "Both YES and NO odds are required.")
    else:
        if (
            yes_odds < settings.binary_side_odds_floor_pct
            or no_odds < settings.binary_side_odds_floor_pct
        ):
            reject(
                "BINARY_SIDE_ODDS_FLOOR",
                "At least one side is below the saved binary-side odds floor.",
            )
        if max(yes_odds, no_odds) < settings.entry_side_odds_floor_pct:
            reject(
                "ENTRY_SIDE_ODDS_FLOOR",
                "Neither side meets the saved new-entry odds floor.",
            )

    quote_at = _parse_datetime(row.get("quote_timestamp"))
    if quote_at is None:
        reject("MISSING_QUOTE_TIMESTAMP", "The odds quote timestamp is unavailable.")
    elif (now - quote_at).total_seconds() > settings.stale_quote_seconds:
        reject("STALE_ODDS", "The latest odds quote is stale and must be refreshed.")

    if any(term in search_text for term in _SPORTS_TERMS):
        reject("SPORTS", "Sports and single-game markets are excluded.")
    if any(term in search_text for term in _WEATHER_TERMS):
        reject("WEATHER", "Weather markets are excluded.")
    if any(term in search_text for term in _SOCIAL_COUNT_TERMS):
        reject("SOCIAL_POST_COUNT", "Tweet/post-count markets are excluded.")
    if any(term in search_text for term in _RELEASE_BY_TERMS):
        reject("RELEASE_BY", "Configured release-by markets are excluded.")
    for term in SPEECH_WORDING_TERMS:
        if re.search(rf"\b{re.escape(term)}\b", search_text, re.I):
            reject(
                "SPEECH_WORDING",
                "Speech, wording or social-post contract is excluded.",
                term,
            )
    for phrase in settings.custom_exclude_phrases:
        if phrase.lower() in search_text:
            reject(
                "CUSTOM_PHRASE",
                "A saved custom exclusion phrase matched the contract packet.",
                phrase,
            )
    return reasons


def build_stage1_output(
    markets: list[dict[str, object]],
    active_positions: list[dict[str, object]],
    *,
    settings: Bullpen008Settings,
    now: datetime,
    universe_complete: bool = True,
    universe_warnings: list[str] | None = None,
) -> dict[str, object]:
    active_by_market: dict[str, list[dict[str, object]]] = defaultdict(list)
    for position in active_positions:
        active_by_market[_market_id(position)].append(position)

    prepared_markets: list[
        tuple[str, dict[str, object], list[dict[str, object]]]
    ] = []
    seen_market_ids: set[str] = set()
    duplicate_market_ids: list[str] = []
    for index, market in enumerate(markets):
        source_market_id = _market_id(market)
        market_id = source_market_id
        forced_reasons: list[dict[str, object]] = []
        if not market_id:
            market_id = f"data-error:missing-market-id:{index}"
            forced_reasons.append(
                {
                    "code": "MISSING_MARKET_ID",
                    "reason": "The scanned market has no stable market identifier.",
                }
            )
        elif market_id in seen_market_ids:
            duplicate_market_ids.append(market_id)
            market_id = f"data-error:duplicate:{market_id}:{index}"
            forced_reasons.append(
                {
                    "code": "DUPLICATE_MARKET_ID",
                    "reason": "The market identifier appeared more than once in the scanned universe.",
                    "duplicate_of_market_id": source_market_id,
                }
            )
        else:
            seen_market_ids.add(market_id)
        prepared_markets.append((market_id, dict(market), forced_reasons))
    for market_id, positions in active_by_market.items():
        if market_id in seen_market_ids:
            continue
        exemplar = positions[0]
        seen_market_ids.add(market_id)
        prepared_markets.append(
            (
                market_id,
                {
                    "market_id": market_id,
                    "condition_id": exemplar.get("condition_id"),
                    "question_id": exemplar.get("question_id"),
                    "parent_event_id": exemplar.get("parent_event_id"),
                    "slug": exemplar.get("slug"),
                    "question": exemplar.get("question")
                    or exemplar.get("market_title"),
                    "category": exemplar.get("category") or exemplar.get("theme"),
                    "outcomes": ["YES", "NO"],
                    "resolution_rules": exemplar.get("resolution_rules"),
                    "resolution_source": exemplar.get("resolution_source"),
                    "deadline": exemplar.get("deadline")
                    or exemplar.get("close_time"),
                    "timezone": exemplar.get("timezone") or "UTC",
                    "open": exemplar.get("classification") == "active",
                    "closed": exemplar.get("classification") == "closed",
                    "resolved": exemplar.get("classification") == "claimable",
                    "claimable": exemplar.get("claimable", False),
                    "accepting_orders": exemplar.get("classification") == "active",
                    "current_yes_odds": exemplar.get("current_yes_odds"),
                    "current_no_odds": exemplar.get("current_no_odds"),
                    "quote_timestamp": exemplar.get("quote_timestamp"),
                    "source": "active-wallet-position",
                },
                [],
            )
        )

    rows: list[dict[str, object]] = []
    rejections: list[dict[str, object]] = []
    accepted = rejected = data_error_accounted = active_count = 0
    stale_data_errors = 0
    for market_id, market, forced_reasons in prepared_markets:
        positions = active_by_market.get(market_id, [])
        is_active_position = bool(positions)
        reasons = [
            *stage1_rejection_reasons(market, settings=settings, now=now),
            *forced_reasons,
        ]
        narrow_band = bool(_NARROW_BAND_PATTERN.search(_search_text(market)))
        data_error_codes = {
            "MISSING_DEADLINE",
            "MISSING_RESOLUTION_RULES",
            "MISSING_ODDS",
            "MISSING_QUOTE_TIMESTAMP",
            "STALE_ODDS",
            "MISSING_MARKET_ID",
            "DUPLICATE_MARKET_ID",
        }
        has_data_error = any(reason["code"] in data_error_codes for reason in reasons)
        if has_data_error:
            stale_data_errors += 1
        if is_active_position:
            accounting_status = "accepted_monitoring"
            active_count += 1
            accepted += 1
        elif has_data_error:
            accounting_status = "data_error"
            data_error_accounted += 1
        elif reasons:
            accounting_status = "rejected"
            rejected += 1
        else:
            accounting_status = "accepted"
            accepted += 1
        if reasons:
            rejections.append(
                {
                    "market_id": market_id,
                    "question": market.get("question"),
                    "reasons": reasons,
                }
            )
        row = {
            **market,
            "market_id": market_id,
            "active_position": is_active_position,
            "held_sides": sorted(
                {
                    _text(position.get("side")).upper()
                    for position in positions
                    if position.get("side")
                }
            ),
            "monitoring_override": is_active_position and bool(reasons),
            "new_entry_eligible": not reasons,
            "narrow_band_flag": narrow_band,
            "stage2_structural_review_required": narrow_band,
            "accounting_status": accounting_status,
            "rejection_reasons": reasons,
        }
        rows.append(row)

    scanned = len(rows)
    accounted = accepted + rejected + data_error_accounted
    pass_condition_met = scanned == accounted and universe_complete
    return {
        "rows": rows,
        "rejections": rejections,
        "duplicates": sorted(set(duplicate_market_ids)),
        "metrics": {
            "scanned": scanned,
            "accepted": accepted,
            "rejected": rejected,
            "active_positions": active_count,
            "data_errors": data_error_accounted,
            "stale_data_errors": stale_data_errors,
            "accounted": accounted,
        },
        "universe_complete": universe_complete,
        "universe_warnings": list(universe_warnings or []),
        "pass_condition_met": pass_condition_met,
        "pass_condition": "The complete source universe was captured and every scanned market is exactly once in accepted, rejected or data-error accounting.",
    }


def build_probability_risk_prompt(rows: list[dict[str, object]]) -> str:
    packet = [
        {
            "market_id": row.get("market_id"),
            "condition_id": row.get("condition_id"),
            "question_id": row.get("question_id"),
            "parent_event_id": row.get("parent_event_id"),
            "slug": row.get("slug"),
            "question": row.get("question"),
            "category": row.get("category"),
            "tags": row.get("tags", []),
            "outcomes": row.get("outcomes", []),
            "resolution_rules": _rules(row),
            "resolution_source": row.get("resolution_source"),
            "deadline": row.get("deadline") or row.get("close_time"),
            "timezone": row.get("timezone"),
            "current_yes_odds": row.get("current_yes_odds"),
            "current_no_odds": row.get("current_no_odds"),
            "quote_timestamp": row.get("quote_timestamp"),
            "open": row.get("open"),
            "closed": row.get("closed"),
            "resolved": row.get("resolved"),
            "claimable": row.get("claimable"),
            "accepting_orders": row.get("accepting_orders"),
            "liquidity": row.get("liquidity"),
            "volume": row.get("volume"),
            "spread": row.get("spread"),
            "context": row.get("context"),
            "active_position": row.get("active_position"),
            "held_sides": row.get("held_sides", []),
            "narrow_band_flag": row.get("narrow_band_flag"),
            "authoritative_evidence_packet": row.get("evidence_packet", {}),
        }
        for row in rows
    ]
    return f"""Prompt version: {LLM_PROMPT_VERSION}
Analyse every supplied prediction-market contract independently. Use only the supplied rules, authoritative evidence packet, deadline, resolution source and market fields. For each contract: state exactly what YES requires; estimate calibrated YES and NO probabilities; recommend YES, NO or SKIP; do not copy market odds; score event unpredictability, resolution ambiguity, threshold sensitivity, data-quality risk and information-shock risk from 0-10; classify structural risk; reject inherently unpredictable speech/wording markets, single-game sports, single-day tail events and unresolved subjective superlative markets unless objective criteria remove the risk; return one row for every market; return strict JSON only.

Required JSON shape:
{{"markets":[{{"market_id":"...","yes_definition":"...","llm_yes_probability":50.0,"llm_no_probability":50.0,"recommended_side":"YES|NO|SKIP","confidence":"Low|Medium|High","evidence_quality":"Low|Moderate|Strong","U":0,"A":0,"T":0,"D":0,"I":0,"auto_reject":false,"watch":false,"sizing_modifier":1.0,"red_flags":[],"rationale":"..."}}]}}

CONTRACTS:
{canonical_json(packet)}"""


def parse_probability_risk_response(raw_response: str) -> list[dict[str, object]]:
    try:
        parsed = json.loads(raw_response)
    except json.JSONDecodeError as exc:
        raise ValueError("Stage 2 provider response was not strict JSON.") from exc
    if not isinstance(parsed, dict) or not isinstance(parsed.get("markets"), list):
        raise ValueError("Stage 2 response must contain a markets array.")
    if not all(isinstance(row, dict) for row in parsed["markets"]):
        raise ValueError("Every Stage 2 markets item must be an object.")
    return [dict(row) for row in parsed["markets"]]


def risk_class(score: float) -> str:
    if score < 4:
        return "eligible"
    if score < 6:
        return "eligible_normal"
    if score < 7:
        return "marginal_half_size"
    if score < 8:
        return "normally_reject"
    return "hard_reject"


def normalize_stage2_rows(
    stage1_rows: list[dict[str, object]],
    provider_rows: list[dict[str, object]],
    *,
    settings: Bullpen008Settings,
    now: datetime,
) -> dict[str, object]:
    expected = {
        _market_id(row): row
        for row in stage1_rows
        if row.get("accounting_status") in {"accepted", "accepted_monitoring"}
    }
    provider_by_id: dict[str, dict[str, object]] = {}
    duplicates: list[str] = []
    for row in provider_rows:
        market_id = _market_id(row)
        if market_id in provider_by_id:
            duplicates.append(market_id)
        elif market_id:
            provider_by_id[market_id] = row
    missing = sorted(set(expected) - set(provider_by_id))
    unexpected = sorted(set(provider_by_id) - set(expected))
    validation_errors: list[dict[str, object]] = []
    normalized: list[dict[str, object]] = []
    for market_id, source in expected.items():
        raw = provider_by_id.get(market_id)
        if raw is None:
            continue
        yes = _float(raw.get("llm_yes_probability"))
        no = _float(raw.get("llm_no_probability"))
        errors: list[str] = []
        if yes is None or no is None or not (0 <= yes <= 100) or not (0 <= no <= 100):
            errors.append("Probabilities must be numbers from 0 to 100.")
        elif abs((yes + no) - 100) > settings.probability_tolerance_pp:
            errors.append(
                f"YES and NO probabilities are not complementary within {settings.probability_tolerance_pp:g} pp."
            )
        recommended = _text(raw.get("recommended_side")).upper()
        if recommended not in {"YES", "NO", "SKIP"}:
            errors.append("recommended_side must be YES, NO or SKIP.")
        components: dict[str, float] = {}
        for key in ("U", "A", "T", "D", "I"):
            value = _float(raw.get(key))
            if value is None or not 0 <= value <= 10:
                errors.append(f"{key} must be scored from 0 to 10.")
            else:
                components[key] = value
        confidence = _text(raw.get("confidence"))
        evidence = _text(raw.get("evidence_quality"))
        if confidence not in {"Low", "Medium", "High"}:
            errors.append("confidence must be Low, Medium or High.")
        if evidence not in {"Low", "Moderate", "Strong"}:
            errors.append("evidence_quality must be Low, Moderate or Strong.")
        if errors:
            validation_errors.append({"market_id": market_id, "errors": errors})
            continue
        assert yes is not None and no is not None
        score = round(
            0.30 * components["U"]
            + 0.25 * components["A"]
            + 0.20 * components["T"]
            + 0.15 * components["D"]
            + 0.10 * components["I"],
            2,
        )
        chosen_side = recommended
        if source.get("active_position") and source.get("held_sides"):
            chosen_side = str(source["held_sides"][0]).upper()
        p_llm = max(yes, no)
        chosen_llm = (
            yes if chosen_side == "YES" else no if chosen_side == "NO" else p_llm
        )
        chosen_market = _float(
            source.get("current_yes_odds")
            if chosen_side == "YES"
            else source.get("current_no_odds")
        )
        edge = round(p_llm - chosen_market, 2) if chosen_market is not None else None
        deadline = _parse_datetime(source.get("deadline") or source.get("close_time"))
        days_until_close = (
            round((deadline - now).total_seconds() / 86_400, 4) if deadline else None
        )
        returns_per_day = None
        if chosen_market is not None and days_until_close is not None:
            try:
                returns_per_day = calculate_returns_per_day_formula(
                    current_chosen_side_bullpen_odds=chosen_market,
                    days_until_close=days_until_close,
                    formula=settings.returns_per_day_formula,
                )
            except (ValueError, ZeroDivisionError):
                returns_per_day = None
        normalized.append(
            {
                **source,
                "yes_definition": raw.get("yes_definition"),
                "llm_yes_probability": round(yes, 2),
                "llm_no_probability": round(no, 2),
                "recommended_side": recommended,
                "chosen_side": chosen_side,
                "p_llm": round(p_llm, 2),
                "chosen_side_llm_probability": round(chosen_llm, 2),
                "current_chosen_side_bullpen_odds": chosen_market,
                "llm_edge_pp": edge,
                "confidence": confidence,
                "evidence_quality": evidence,
                "risk_components": components,
                "risk_score": score,
                "risk_class": risk_class(score),
                "auto_reject": bool(raw.get("auto_reject"))
                or score >= settings.risk_hard_reject_threshold,
                "watch": bool(raw.get("watch"))
                or 6 <= score < settings.risk_reject_threshold,
                "sizing_modifier": 0.5
                if 6 <= score < 7
                else _float(raw.get("sizing_modifier")) or 1,
                "red_flags": raw.get("red_flags")
                if isinstance(raw.get("red_flags"), list)
                else [],
                "rationale": raw.get("rationale"),
                "days_until_close": days_until_close,
                "returns_per_day": returns_per_day,
            }
        )
    analysed = len(normalized)
    pass_condition_met = (
        not missing
        and not unexpected
        and not duplicates
        and not validation_errors
        and analysed == len(expected)
    )
    return {
        "rows": normalized,
        "metrics": {
            "analysed": analysed,
            "chosen_side_llm_odds_gte_80": sum(
                1
                for row in normalized
                if float(row["chosen_side_llm_probability"]) >= 80
            ),
            "positive_edge": sum(
                1
                for row in normalized
                if isinstance(row.get("llm_edge_pp"), (int, float))
                and row["llm_edge_pp"] > 0
            ),
            "high_risk_rejects": sum(
                1 for row in normalized if float(row["risk_score"]) >= 7
            ),
            "llm_failures": len(missing) + len(validation_errors),
        },
        "missing_market_ids": missing,
        "unexpected_market_ids": unexpected,
        "duplicate_market_ids": sorted(set(duplicates)),
        "validation_errors": validation_errors,
        "pass_condition_met": pass_condition_met,
        "pass_condition": "Every eligible row has complementary probabilities, evidence status and structural-risk classification.",
    }


def _cluster_stem(row: dict[str, object]) -> str:
    parent = _text(row.get("parent_event_id") or row.get("event_slug"))
    if parent:
        return re.sub(r"[^a-z0-9]+", "-", parent.lower()).strip("-")
    source = _text(row.get("slug") or row.get("question")).lower()
    source = _DATE_TOKEN_PATTERN.sub("date", source)
    source = _THRESHOLD_TOKEN_PATTERN.sub("threshold", source)
    source = re.sub(r"[^a-z0-9]+", "-", source).strip("-")
    return source[:120] or stable_hash(row)[:16]


def deterministic_cluster_seed(
    rows: list[dict[str, object]],
) -> dict[str, dict[str, str]]:
    result: dict[str, dict[str, str]] = {}
    for row in rows:
        market_id = _market_id(row)
        stem = _cluster_stem(row)
        category = re.sub(r"[^a-z0-9]+", "-", _text(row.get("category")).lower()).strip(
            "-"
        )
        question = _text(row.get("question")).lower()
        catalyst_terms = [
            token
            for token in re.findall(r"[a-z0-9]+", question)
            if len(token) >= 5
            and token not in {"would", "could", "before", "after", "market"}
        ]
        catalyst = "-".join(catalyst_terms[:4]) or category or stem
        result[market_id] = {
            "strict_cluster_id": f"strict:{stem}",
            "common_catalyst_cluster_id": f"catalyst:{category}:{catalyst}"[:180],
        }
    return result


def build_cluster_prompt(rows: list[dict[str, object]]) -> str:
    packet = [
        {
            "market_id": row.get("market_id"),
            "parent_event_id": row.get("parent_event_id"),
            "event_slug": row.get("event_slug"),
            "slug": row.get("slug"),
            "question": row.get("question"),
            "deadline": row.get("deadline") or row.get("close_time"),
            "resolution_rules": _rules(row),
            "category": row.get("category"),
            "chosen_side": row.get("chosen_side"),
            "active_position": row.get("active_position"),
        }
        for row in rows
    ]
    return f"""Prompt version: {CLUSTER_PROMPT_VERSION}
Cluster the complete supplied market universe in one comparison. Create strict-resolution clusters for contracts mechanically determined by the same final result. Create broader common-catalyst clusters for contracts that could materially lose or move together following one realistic development. Keep different deadlines, ranges, thresholds and candidates linked. Group geopolitical contracts broadly when one escalation, ceasefire breach, agreement or diplomatic breakthrough affects several markets. Prefer the broader common-catalyst cluster when uncertain. Apply transitive closure. Return every market exactly once. Explain the shared driver and main joint-loss scenario.

IMPORTANT: adjudication_status describes whether the CLUSTER ASSIGNMENT is fully adjudicated; it does not describe whether the prediction contract or real-world event has resolved. A future deadline, unsettled market or unknown outcome is not a reason to mark clustering unresolved. Return adjudication_status="resolved" whenever both cluster assignments are complete and unambiguous. Return "unresolved" only when the supplied fields leave a genuine cluster-membership ambiguity that you cannot decide; explain the competing cluster assignments in adjudication_reason. Return strict JSON only.

Required JSON shape:
{{"markets":[{{"market_id":"...","strict_cluster_id":"...","common_catalyst_cluster_id":"...","driver":"...","main_joint_loss_trigger":"...","adjudication_status":"resolved|unresolved","adjudication_reason":"..."}}]}}

MARKETS:
{canonical_json(packet)}"""


def parse_cluster_response(raw_response: str) -> list[dict[str, object]]:
    try:
        parsed = json.loads(raw_response)
    except json.JSONDecodeError as exc:
        raise ValueError("Stage 3 provider response was not strict JSON.") from exc
    if not isinstance(parsed, dict) or not isinstance(parsed.get("markets"), list):
        raise ValueError("Stage 3 response must contain a markets array.")
    if not all(isinstance(row, dict) for row in parsed["markets"]):
        raise ValueError("Every Stage 3 markets item must be an object.")
    return [dict(row) for row in parsed["markets"]]


class _DisjointSet:
    def __init__(self, values: Iterable[str]) -> None:
        self.parent = {value: value for value in values}

    def find(self, value: str) -> str:
        parent = self.parent[value]
        if parent != value:
            self.parent[value] = self.find(parent)
        return self.parent[value]

    def union(self, left: str, right: str) -> None:
        root_left = self.find(left)
        root_right = self.find(right)
        if root_left != root_right:
            self.parent[root_right] = root_left


def normalize_cluster_rows(
    market_rows: list[dict[str, object]],
    provider_rows: list[dict[str, object]],
    *,
    existing_exposure_by_market: dict[str, float],
    pending_buy_exposure_by_market: dict[str, float],
    confirmed_exit_exposure_by_market: dict[str, float],
    settings: Bullpen008Settings,
) -> dict[str, object]:
    expected = {_market_id(row): row for row in market_rows}
    provider_by_id: dict[str, dict[str, object]] = {}
    duplicates: list[str] = []
    for row in provider_rows:
        market_id = _market_id(row)
        if market_id in provider_by_id:
            duplicates.append(market_id)
        elif market_id:
            provider_by_id[market_id] = row
    missing = sorted(set(expected) - set(provider_by_id))
    unexpected = sorted(set(provider_by_id) - set(expected))
    seed = deterministic_cluster_seed(market_rows)

    strict_dsu = _DisjointSet(expected)
    catalyst_dsu = _DisjointSet(expected)
    strict_groups: dict[str, list[str]] = defaultdict(list)
    catalyst_groups: dict[str, list[str]] = defaultdict(list)
    for market_id in expected:
        provider = provider_by_id.get(market_id, {})
        strict_groups[
            _text(provider.get("strict_cluster_id"))
            or seed[market_id]["strict_cluster_id"]
        ].append(market_id)
        catalyst_groups[
            _text(provider.get("common_catalyst_cluster_id"))
            or seed[market_id]["common_catalyst_cluster_id"]
        ].append(market_id)
    for groups, dsu in ((strict_groups, strict_dsu), (catalyst_groups, catalyst_dsu)):
        for members in groups.values():
            for member in members[1:]:
                dsu.union(members[0], member)
    deterministic_strict_groups: dict[str, list[str]] = defaultdict(list)
    for market_id, values in seed.items():
        deterministic_strict_groups[values["strict_cluster_id"]].append(market_id)
    for members in deterministic_strict_groups.values():
        for member in members[1:]:
            strict_dsu.union(members[0], member)
            catalyst_dsu.union(members[0], member)

    strict_members: dict[str, list[str]] = defaultdict(list)
    catalyst_members: dict[str, list[str]] = defaultdict(list)
    for market_id in expected:
        strict_members[strict_dsu.find(market_id)].append(market_id)
        catalyst_members[catalyst_dsu.find(market_id)].append(market_id)

    rows: list[dict[str, object]] = []
    unresolved: list[dict[str, object]] = []
    validation_errors: list[dict[str, object]] = []
    for market_id, source in expected.items():
        provider = provider_by_id.get(market_id, {})
        strict_root = strict_dsu.find(market_id)
        catalyst_root = catalyst_dsu.find(market_id)
        strict_id = f"strict:{stable_hash(sorted(strict_members[strict_root]))[:16]}"
        catalyst_id = (
            f"catalyst:{stable_hash(sorted(catalyst_members[catalyst_root]))[:16]}"
        )
        status = _text(provider.get("adjudication_status")).lower() or "unresolved"
        field_errors: list[str] = []
        for field, label in (
            ("strict_cluster_id", "strict cluster ID"),
            ("common_catalyst_cluster_id", "common-catalyst cluster ID"),
            ("driver", "shared driver"),
            ("main_joint_loss_trigger", "main joint-loss trigger"),
            ("adjudication_reason", "adjudication reason"),
        ):
            if not _text(provider.get(field)):
                field_errors.append(f"Missing {label}.")
        if status not in {"resolved", "unresolved"}:
            field_errors.append("adjudication_status must be resolved or unresolved.")
        if field_errors:
            validation_errors.append(
                {"market_id": market_id, "errors": field_errors}
            )
        if status != "resolved" or field_errors:
            unresolved.append(
                {
                    "market_id": market_id,
                    "reason": "; ".join(field_errors)
                    or provider.get("adjudication_reason")
                    or "Semantic cluster adjudication is unresolved.",
                }
            )
        existing = round(existing_exposure_by_market.get(market_id, 0), 2)
        pending = round(pending_buy_exposure_by_market.get(market_id, 0), 2)
        confirmed_exit = round(confirmed_exit_exposure_by_market.get(market_id, 0), 2)
        current = max(0.0, existing + pending - confirmed_exit)
        rows.append(
            {
                **source,
                "strict_cluster_id": strict_id,
                "common_catalyst_cluster_id": catalyst_id,
                "driver": provider.get("driver"),
                "strict_cluster_members": sorted(strict_members[strict_root]),
                "common_catalyst_cluster_members": sorted(
                    catalyst_members[catalyst_root]
                ),
                "main_joint_loss_trigger": provider.get("main_joint_loss_trigger"),
                "existing_exposure_usd": existing,
                "pending_exposure_usd": pending,
                "confirmed_exit_exposure_usd": confirmed_exit,
                "current_exposure_usd": round(current, 2),
                "maximum_capacity_usd": settings.max_common_catalyst_exposure_usd,
                "remaining_capacity_usd": round(
                    max(0, settings.max_common_catalyst_exposure_usd - current), 2
                ),
                "adjudication_status": status,
                "adjudication_reason": provider.get("adjudication_reason"),
            }
        )

    strict_exposure: dict[str, float] = defaultdict(float)
    catalyst_exposure: dict[str, float] = defaultdict(float)
    for row in rows:
        strict_exposure[str(row["strict_cluster_id"])] += float(
            row["current_exposure_usd"]
        )
        catalyst_exposure[str(row["common_catalyst_cluster_id"])] += float(
            row["current_exposure_usd"]
        )
    for row in rows:
        catalyst_total = catalyst_exposure[str(row["common_catalyst_cluster_id"])]
        row["remaining_capacity_usd"] = round(
            max(0, settings.max_common_catalyst_exposure_usd - catalyst_total),
            2,
        )
    pass_condition_met = (
        not missing
        and not unexpected
        and not duplicates
        and not unresolved
        and not validation_errors
    )
    return {
        "rows": rows,
        "metrics": {
            "strict_clusters": len(strict_exposure),
            "common_catalyst_clusters": len(catalyst_exposure),
            "duplicates_date_ladders": sum(
                1 for members in strict_members.values() if len(members) > 1
            ),
            "largest_current_exposure": round(max([*catalyst_exposure.values(), 0]), 2),
            "unresolved_adjudications": len(unresolved),
        },
        "strict_cluster_exposure": {
            key: round(value, 2) for key, value in strict_exposure.items()
        },
        "common_catalyst_exposure": {
            key: round(value, 2) for key, value in catalyst_exposure.items()
        },
        "missing_market_ids": missing,
        "unexpected_market_ids": unexpected,
        "duplicate_market_ids": sorted(set(duplicates)),
        "unresolved_adjudications": unresolved,
        "validation_errors": validation_errors,
        "pass_condition_met": pass_condition_met,
        "pass_condition": "Every market is assigned exactly once and no semantic-cluster adjudication remains unresolved.",
    }


def _normalize_metric(values: list[float | None]) -> list[float]:
    valid = [value for value in values if value is not None and math.isfinite(value)]
    if not valid:
        return [0 for _ in values]
    low, high = min(valid), max(valid)
    if high == low:
        return [1 if value is not None else 0 for value in values]
    return [
        (value - low) / (high - low)
        if value is not None and math.isfinite(value)
        else 0
        for value in values
    ]


def build_portfolio_target(
    rows: list[dict[str, object]],
    *,
    settings: Bullpen008Settings,
    available_cash_usd: float,
    inputs_hash: str,
    account_identity: str | None = None,
) -> dict[str, object]:
    edge_norm = _normalize_metric([_float(row.get("llm_edge_pp")) for row in rows])
    returns_norm = _normalize_metric(
        [_float(row.get("returns_per_day")) for row in rows]
    )
    evidence_rank = {"Low": 0.25, "Moderate": 0.65, "Strong": 1.0}
    confidence_rank = {"Low": 0.25, "Medium": 0.65, "High": 1.0}
    candidates: list[dict[str, object]] = []
    for index, row in enumerate(rows):
        evidence = evidence_rank.get(_text(row.get("evidence_quality")), 0)
        confidence = confidence_rank.get(_text(row.get("confidence")), 0)
        objectivity = max(
            0, 1 - float(row.get("risk_components", {}).get("A", 10)) / 10
        )
        breadth = (
            1.0
            if row.get("chosen_side") == "NO"
            and row.get("strict_cluster_members")
            and len(row["strict_cluster_members"]) > 1
            else 0.5
        )
        risk_penalty = float(row.get("risk_score") or 10) / 10 * 0.35
        score = (
            0.35 * edge_norm[index]
            + 0.25 * returns_norm[index]
            + 0.15 * ((evidence + confidence) / 2)
            + 0.15 * objectivity
            + 0.10 * breadth
            - risk_penalty
        )
        market_odds = _float(row.get("current_chosen_side_bullpen_odds"))
        llm_odds = _float(row.get("chosen_side_llm_probability"))
        edge = _float(row.get("llm_edge_pp"))
        risk = _float(row.get("risk_score"))
        eligible_reasons: list[str] = []
        if _text(row.get("chosen_side")).upper() not in {"YES", "NO"}:
            eligible_reasons.append("SKIP_OR_INVALID_RECOMMENDATION")
        if llm_odds is None or llm_odds < settings.min_llm_probability_pct:
            eligible_reasons.append("LLM_ODDS_BELOW_80")
        if market_odds is None or market_odds < settings.entry_side_odds_floor_pct:
            eligible_reasons.append("MARKET_ODDS_BELOW_80")
        if edge is None or edge < settings.minimum_edge_pp:
            eligible_reasons.append("NEGATIVE_EDGE")
        elif (
            edge < settings.preferred_min_edge_pp
            and not (
                row.get("active_position")
                and float(row.get("current_exposure_usd") or 0) > 0
            )
        ):
            eligible_reasons.append("EDGE_BELOW_PREFERRED_NOT_STABILISER")
        if (
            row.get("open") is not True
            or row.get("closed")
            or row.get("resolved")
            or row.get("claimable")
        ):
            eligible_reasons.append("MARKET_NOT_OPEN")
        days_until_close = _float(row.get("days_until_close"))
        if days_until_close is None or days_until_close <= 0:
            eligible_reasons.append("DEADLINE_MISSING_OR_PASSED")
        if row.get("new_entry_eligible") is False and not row.get("active_position"):
            eligible_reasons.append("STAGE1_REJECTED")
        if (
            risk is None
            or risk >= settings.risk_reject_threshold
            or row.get("auto_reject")
        ):
            eligible_reasons.append("RISK_REJECTED")
        if row.get("adjudication_status") != "resolved":
            eligible_reasons.append("CLUSTER_UNRESOLVED")
        if not row.get("strict_cluster_id") or not row.get(
            "common_catalyst_cluster_id"
        ):
            eligible_reasons.append("CLUSTER_DATA_MISSING")
        if not row.get("confidence") or not row.get("evidence_quality"):
            eligible_reasons.append("REQUIRED_DATA_INCOMPLETE")
        if (
            row.get("adjudication_required")
            or _text(row.get("llm_disagreement_level")).lower() == "high"
        ):
            eligible_reasons.append("LLM_DISAGREEMENT_UNACCEPTABLE")
        candidates.append(
            {
                **row,
                "selection_score": round(score, 6),
                "eligible": not eligible_reasons,
                "eligibility_reasons": eligible_reasons,
            }
        )

    candidates_by_cluster: dict[str, list[dict[str, object]]] = defaultdict(list)
    for candidate in candidates:
        candidates_by_cluster[
            str(candidate.get("common_catalyst_cluster_id"))
        ].append(candidate)
    representatives: dict[str, dict[str, object]] = {}
    for cluster_id, cluster_candidates in candidates_by_cluster.items():
        ranked = sorted(
            cluster_candidates,
            key=lambda row: float(row["selection_score"]),
            reverse=True,
        )
        representatives[cluster_id] = next(
            (candidate for candidate in ranked if candidate["eligible"]),
            ranked[0],
        )

    # Phase 2 makes Stage 4 authoritative over reductions as well as additions.
    # Start from zero target exposure, retain only the highest-ranked eligible
    # representative in each catalyst cluster, and trim every cap breach in the
    # target. Stage 5 may translate these frozen reductions but cannot invent
    # them or redirect the released cash.
    contract_exposure: dict[str, float] = defaultdict(float)
    strict_exposure: dict[str, float] = defaultdict(float)
    catalyst_exposure: dict[str, float] = defaultdict(float)
    target_before_buys: dict[str, float] = defaultdict(float)
    for cluster_id, representative in representatives.items():
        if not representative["eligible"]:
            continue
        market_id = _market_id(representative)
        strict_id = str(representative.get("strict_cluster_id"))
        common_id = str(representative.get("common_catalyst_cluster_id"))
        normal_cap = settings.max_contract_exposure_usd
        risk = float(representative.get("risk_score") or 10)
        if settings.risk_half_size_min <= risk <= settings.risk_half_size_max:
            normal_cap = min(normal_cap, settings.max_contract_exposure_usd / 2)
        retained = min(
            float(representative.get("current_exposure_usd") or 0),
            normal_cap,
            settings.max_strict_cluster_exposure_usd,
            settings.max_common_catalyst_exposure_usd,
        )
        retained = round(max(0.0, retained), 2)
        target_before_buys[market_id] = retained
        contract_exposure[market_id] = retained
        strict_exposure[strict_id] += retained
        catalyst_exposure[common_id] += retained

    existing_total_exposure = sum(target_before_buys.values())
    cash_for_buys = min(
        max(0.0, available_cash_usd),
        max(0.0, settings.bankroll_usd - existing_total_exposure),
    )
    allocations: list[dict[str, object]] = []
    for cluster_id, candidate in sorted(
        representatives.items(),
        key=lambda item: float(item[1]["selection_score"]),
        reverse=True,
    ):
        market_id = _market_id(candidate)
        strict_id = str(candidate.get("strict_cluster_id"))
        common_id = str(candidate.get("common_catalyst_cluster_id"))
        allocation = 0.0
        explanation = list(candidate["eligibility_reasons"])
        current_exposure = float(candidate.get("current_exposure_usd") or 0)
        retained_exposure = target_before_buys.get(market_id, 0.0)
        proposed_sell = max(0.0, current_exposure - retained_exposure)
        if proposed_sell > 0:
            explanation.append("STAGE4_TARGET_REDUCTION")
        if candidate["eligible"]:
            normal_cap = settings.max_contract_exposure_usd
            risk = float(candidate.get("risk_score") or 10)
            if settings.risk_half_size_min <= risk <= settings.risk_half_size_max:
                normal_cap = min(normal_cap, settings.max_contract_exposure_usd / 2)
                explanation.append("RISK_HALF_SIZE")
            capacity = min(
                normal_cap - contract_exposure[market_id],
                settings.max_strict_cluster_exposure_usd - strict_exposure[strict_id],
                settings.max_common_catalyst_exposure_usd
                - catalyst_exposure[common_id],
                cash_for_buys,
            )
            allocation = (
                math.floor(max(0.0, capacity) / settings.allocation_increment_usd)
                * settings.allocation_increment_usd
            )
            edge = float(candidate.get("llm_edge_pp") or 0)
            if 0 <= edge < settings.preferred_min_edge_pp:
                explanation.append("STABILISER_EDGE_0_TO_0_24")
            if allocation > 0:
                contract_exposure[market_id] += allocation
                strict_exposure[strict_id] += allocation
                catalyst_exposure[common_id] += allocation
                cash_for_buys -= allocation
            elif not explanation:
                explanation.append("NO_REMAINING_CAPACITY_OR_CASH")
        allocations.append(
            {
                "market_id": market_id,
                "question": candidate.get("question"),
                "chosen_side": candidate.get("chosen_side"),
                "strict_cluster_id": strict_id,
                "common_catalyst_cluster_id": common_id,
                "current_exposure_usd": round(
                    current_exposure, 2
                ),
                "proposed_sell_usd": round(proposed_sell, 2),
                "proposed_buy_usd": round(allocation, 2),
                "target_exposure_usd": round(retained_exposure + allocation, 2),
                "condition_id": candidate.get("condition_id"),
                "slug": candidate.get("slug"),
                "deadline": candidate.get("deadline"),
                "quote_timestamp": candidate.get("quote_timestamp"),
                "current_odds": candidate.get("current_chosen_side_bullpen_odds"),
                "llm_odds": candidate.get("chosen_side_llm_probability"),
                "edge_pp": candidate.get("llm_edge_pp"),
                "returns_per_day": candidate.get("returns_per_day"),
                "risk_score": candidate.get("risk_score"),
                "selection_score": candidate.get("selection_score"),
                "explanation_codes": explanation,
            }
        )

    representative_market_ids = {
        _market_id(candidate) for candidate in representatives.values()
    }
    for candidate in sorted(
        candidates, key=lambda row: float(row["selection_score"]), reverse=True
    ):
        market_id = _market_id(candidate)
        if market_id in representative_market_ids:
            continue
        current_exposure = round(float(candidate.get("current_exposure_usd") or 0), 2)
        target_exposure = target_before_buys.get(market_id, 0.0)
        allocations.append(
            {
                "market_id": market_id,
                "question": candidate.get("question"),
                "chosen_side": candidate.get("chosen_side"),
                "strict_cluster_id": str(candidate.get("strict_cluster_id")),
                "common_catalyst_cluster_id": str(
                    candidate.get("common_catalyst_cluster_id")
                ),
                "current_exposure_usd": current_exposure,
                "proposed_sell_usd": round(max(0.0, current_exposure - target_exposure), 2),
                "proposed_buy_usd": 0.0,
                "target_exposure_usd": round(target_exposure, 2),
                "condition_id": candidate.get("condition_id"),
                "slug": candidate.get("slug"),
                "deadline": candidate.get("deadline"),
                "quote_timestamp": candidate.get("quote_timestamp"),
                "current_odds": candidate.get(
                    "current_chosen_side_bullpen_odds"
                ),
                "llm_odds": candidate.get("chosen_side_llm_probability"),
                "edge_pp": candidate.get("llm_edge_pp"),
                "returns_per_day": candidate.get("returns_per_day"),
                "risk_score": candidate.get("risk_score"),
                "selection_score": candidate.get("selection_score"),
                "explanation_codes": [
                    *list(candidate["eligibility_reasons"]),
                    "NOT_CLUSTER_REPRESENTATIVE",
                    *(["STAGE4_TARGET_REDUCTION"] if current_exposure > target_exposure else []),
                ],
            }
        )

    all_exposures = [*contract_exposure.values(), 0]
    all_strict = [*strict_exposure.values(), 0]
    all_catalyst = [*catalyst_exposure.values(), 0]
    largest_contract = round(max(all_exposures), 2)
    largest_strict = round(max(all_strict), 2)
    largest_catalyst = round(max(all_catalyst), 2)
    contract_cap_result = largest_contract <= settings.max_contract_exposure_usd + 1e-9
    cluster_cap_result = (
        largest_strict <= settings.max_strict_cluster_exposure_usd + 1e-9
        and largest_catalyst <= settings.max_common_catalyst_exposure_usd + 1e-9
    )
    stress_trigger_by_cluster = {
        str(row.get("common_catalyst_cluster_id")): row.get("main_joint_loss_trigger")
        for row in candidates
    }
    stress_scenarios = [
        {
            "common_catalyst_cluster_id": cluster_id,
            "main_adverse_catalyst": stress_trigger_by_cluster.get(cluster_id),
            "affected_exposure_usd": round(exposure, 2),
            "result": "pass"
            if exposure <= settings.max_common_catalyst_exposure_usd + 1e-9
            else "fail",
        }
        for cluster_id, exposure in sorted(catalyst_exposure.items())
    ]
    stress_test_result = all(
        scenario["result"] == "pass" for scenario in stress_scenarios
    )
    proposed_buys = round(sum(float(row["proposed_buy_usd"]) for row in allocations), 2)
    invested_amount = round(sum(contract_exposure.values()), 2)
    cash_retained = round(max(0, settings.bankroll_usd - invested_amount), 2)
    bankroll_result = invested_amount <= settings.bankroll_usd + 1e-9
    selected_buys = [
        row for row in allocations if float(row["proposed_buy_usd"]) > 0
    ]
    target_rows = [
        row for row in allocations if float(row["target_exposure_usd"]) > 0
    ]
    target_exposure_total = sum(
        float(row["target_exposure_usd"]) for row in target_rows
    )
    weighted_current = (
        sum(
            float(row["current_odds"] or 0) * float(row["target_exposure_usd"])
            for row in target_rows
        )
        / target_exposure_total
        if target_exposure_total
        else 0
    )
    weighted_llm = (
        sum(
            float(row["llm_odds"] or 0) * float(row["target_exposure_usd"])
            for row in target_rows
        )
        / target_exposure_total
        if target_exposure_total
        else 0
    )
    weighted_edge = (
        weighted_llm - weighted_current if target_exposure_total else 0
    )
    dollar_return_per_day = sum(
        float(row["target_exposure_usd"])
        * float(row["returns_per_day"] or 0)
        / 100
        for row in target_rows
    )
    maximum_payout = sum(
        float(row["target_exposure_usd"])
        * 100
        / max(float(row["current_odds"] or 100), 0.01)
        for row in target_rows
    )
    expected_profit = sum(
        float(row["target_exposure_usd"])
        * (
            (float(row["llm_odds"] or 0) / max(float(row["current_odds"] or 100), 0.01))
            - 1
        )
        for row in target_rows
    )
    invested_cluster_ids = {
        str(row["common_catalyst_cluster_id"]) for row in target_rows
    }
    portfolio_certified = (
        bankroll_result
        and contract_cap_result
        and cluster_cap_result
        and stress_test_result
    )
    certificate = {
        "bankroll": settings.bankroll_usd,
        "invested_amount": invested_amount,
        "cash_retained": cash_retained,
        "available_cash_before_proposals": round(available_cash_usd, 2),
        "proposed_buys": proposed_buys,
        "bankroll_result": bankroll_result,
        "largest_contract_exposure": largest_contract,
        "largest_strict_cluster_exposure": largest_strict,
        "largest_common_catalyst_exposure": largest_catalyst,
        "contract_cap_result": contract_cap_result,
        "cluster_cap_result": cluster_cap_result,
        "stress_test_result": stress_test_result,
        "inputs_hash": inputs_hash,
        "account_identity": account_identity,
        "target_portfolio_hash": stable_hash(allocations),
        "cluster_map_version": CLUSTER_MAP_VERSION,
        "optimizer_version": OPTIMIZER_VERSION,
        "portfolio_certified": portfolio_certified,
    }
    certificate["certificate_hash"] = stable_hash(certificate)
    return {
        "allocations": allocations,
        "stress_scenarios": stress_scenarios,
        "certificate": certificate,
        "metrics": {
            "selected_contracts": len(target_rows),
            "new_buy_contracts": len(selected_buys),
            "invested": invested_amount,
            "cash_retained": cash_retained,
            "independent_clusters": len(invested_cluster_ids),
            "stress_test_result": "pass" if stress_test_result else "fail",
        },
        "portfolio_metrics": {
            "weighted_current_odds": round(weighted_current, 2),
            "weighted_llm_odds": round(weighted_llm, 2),
            "weighted_edge_pp": round(weighted_edge, 2),
            "dollar_return_per_day": round(dollar_return_per_day, 2),
            "maximum_payout": round(maximum_payout, 2),
            "llm_implied_expected_profit": round(expected_profit, 2),
            "invested_amount": invested_amount,
            "cash_retained": cash_retained,
            "independent_clusters": len(invested_cluster_ids),
        },
        "pass_condition_met": portfolio_certified,
        "pass_condition": "The deterministic portfolio certificate is valid and every contract, cluster and adverse-scenario cap passes.",
    }


def verify_portfolio_certificate(certificate: dict[str, object]) -> bool:
    supplied_hash = _text(certificate.get("certificate_hash"))
    payload = {
        key: value for key, value in certificate.items() if key != "certificate_hash"
    }
    return (
        bool(supplied_hash)
        and supplied_hash == stable_hash(payload)
        and certificate.get("portfolio_certified") is True
    )
