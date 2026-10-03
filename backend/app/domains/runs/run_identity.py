"""Market and stage of the run itself, excluding quoted input-bundle text."""
from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any


@dataclass(frozen=True)
class AnalysisRunIdentity:
    market: str | None = None
    stage: str | None = None


def _opening_market(text: str) -> str | None:
    india = bool(re.search(r"\b(?:zerodha|india|indian|nse|bse|inr)\b", text, re.I))
    us = bool(re.search(
        r"\b(?:indmoney|nasdaq|nyse|usd|united states)\b|\b(?:us|u\.s\.)\s+(?:aggressive|equity|equities|stocks|portfolio|swing|rebalance)",
        text, re.I,
    ))
    return None if india == us else "india" if india else "us"


def analysis_run_identity(run: Any) -> AnalysisRunIdentity:
    unknown = AnalysisRunIdentity()
    portfolio = getattr(run, "auto_rebalance_portfolio", None)
    if portfolio and portfolio not in {"india", "indmoney_us"}:
        return unknown
    metadata_market = {"india": "india", "indmoney_us": "us"}.get(portfolio)
    label = (getattr(run, "auto_rebalance_label", None) or "").strip()
    label_match = re.search(r"\b(swing|rebalance|technical|threats?)\s+scan\)?\s*$", label, re.I)
    label_stage = label_match.group(1).lower() if label_match else None
    if label_stage and label_stage.startswith("threat"):
        label_stage = "threats"
    label_market = "india" if re.match(r"India Run\b", label, re.I) else "us" if re.match(r"IndMoney US Run\b", label, re.I) else None
    if metadata_market and label_market and metadata_market != label_market:
        return unknown

    raw_prompt = getattr(run, "prompt", None)
    prompt = (raw_prompt if raw_prompt is not None else getattr(run, "prompt_preview", None) or "").lstrip()
    opening = re.split(r"\n\s*\n", prompt, maxsplit=1)[0][:1000]
    marker = re.match(r"\[REBALANCE_FLOW:(india|us)\]", prompt, re.I)
    prompt_stage = None
    marker_market = None
    if marker:
        prompt_stage, marker_market = "rebalance", marker.group(1).lower()
    elif re.match(r"##\s*Technical Scan Input Bundle\b", prompt, re.I):
        prompt_stage = "technical"
        us_header = bool(re.search(r"^Market:\s*US equities\s*$", opening, re.I | re.M))
        india_header = bool(re.search(r"^Market:\s*India equities\s*$", opening, re.I | re.M))
        if us_header and india_header:
            return unknown
        marker_market = "us" if us_header else "india" if india_header else None
    elif re.match(r"\[(?:ZERODHA|INDMONEY_US)_THREATS\]", prompt, re.I):
        prompt_stage = "threats"
        marker_market = "india" if re.match(r"\[ZERODHA_THREATS\]", prompt, re.I) else "us"
    explicit_market = metadata_market or label_market
    if explicit_market and marker_market and explicit_market != marker_market:
        return unknown
    if label_stage and prompt_stage and label_stage != prompt_stage:
        return unknown
    legacy_stage = "rebalance" if re.search(r"\brebalanc(?:e|ing)\b", opening, re.I) else "swing" if re.search(r"\bswing[-\s]*trad(?:e|ing)|\bswing scan\b", opening, re.I) else None
    return AnalysisRunIdentity(
        market=explicit_market or marker_market or _opening_market(opening),
        stage=label_stage or prompt_stage or legacy_stage,
    )
