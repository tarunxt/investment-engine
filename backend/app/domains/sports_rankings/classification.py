"""Phase-one classification contract. Does not execute or change Bullpen trades."""
import re
from pydantic import BaseModel, Field

from .catalogue import normalize_name
from .master import SPORT_BY_ID

CONDITIONAL_SPORTS = {"formula-1", "horse-racing", "cycling", "athletics", "swimming", "skiing", "surfing", "golf-tournament", "pubg-h2h", "golf-match-play", "ten-pin-bowling", "shooting-match-play", "archery-match-play"}
ALLOWED_MARKETS = {"winner", "moneyline", "match_result", "win_loss", "head_to_head"}


class MatchCandidate(BaseModel):
    sport_id: str = Field(max_length=80)
    participants: list[str] = Field(default_factory=list, max_length=100)
    question: str = Field(default="", max_length=2000)
    market_type: str | None = Field(default=None, max_length=60)
    scope: str | None = Field(default=None, max_length=60)
    period: str | None = Field(default=None, max_length=60)
    explicit_head_to_head: bool = False
    has_handicap: bool = False
    has_total: bool = False
    has_player_stat: bool = False


def classify(candidate):
    reasons = []
    names = [normalize_name(n) for n in candidate.participants]
    if len(names) != 2 or len(set(names)) != 2 or not all(names):
        reasons.append("Exactly two distinct opposing participants are required; Yes/No outcomes are not participant identities.")
    if any(n in {"yes", "no", "draw", "tie"} for n in names):
        reasons.append("Outcome labels cannot stand in for participant names.")
    if candidate.sport_id not in SPORT_BY_ID and candidate.sport_id not in CONDITIONAL_SPORTS:
        reasons.append("Unknown sport requires classification review.")
    if candidate.market_type not in ALLOWED_MARKETS:
        reasons.append("Only winner, win/loss, moneyline or match-result markets qualify.")
    if candidate.scope != "match" or candidate.period != "full_match":
        reasons.append("Verified full-match scope is required; tournament winners and partial-match markets are excluded.")
    if candidate.has_handicap or candidate.has_total or candidate.has_player_stat:
        reasons.append("Handicap, spread, total and player-statistic markets are excluded.")
    if re.search(r"\b(over\s*/\s*under|(?:over|under)\s+\d|handicap|spread|total(?:s)?|exact score|correct score|(?:win|wins|score|finish)\s+\d+\s*[-:]\s*\d+|(?:first|second|third|fourth|1st|2nd|3rd|4th)\s+(?:half|set|map|period|quarter|innings?)|(?:half|set|map|period|quarter|inning)s?\s*\d|tournament winner|win the tournament)\b", candidate.question, re.I):
        reasons.append("Question describes an excluded line, score, partial-match or outright market.")
    if candidate.sport_id in CONDITIONAL_SPORTS and not candidate.explicit_head_to_head:
        reasons.append("This discipline requires an explicit head-to-head or match-play market; ordinary multi-participant events are excluded.")
    return {"eligible": not reasons, "reasons": reasons, "sport_id": candidate.sport_id, "rules_version": 1, "automatic_analysis_enabled": False}
