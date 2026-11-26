"""Versioned discovery rules evaluated on observed listing and candle data."""
import ast
from functools import lru_cache
from statistics import mean, median

from pydantic import BaseModel, ConfigDict, Field, model_validator
from .query import compile_expression, evaluate

FLAGS = ("universe", "liquidity", "touches", "rebound", "proximity")
INDEX_SIZES = (50, 100, 200, 500)
RANGE = ("L", "H", "R")
FIELDS = {
    "universe": (*(f"Nifty {n} member" for n in INDEX_SIZES), "NSE equity", "ISIN match"),
    "liquidity": ("Median turnover", "Mean turnover", "Median volume", *RANGE),
    "touches": ("Daily low", "Daily high", "Daily close", *RANGE),
    "rebound": ("Between touches high", *RANGE),
    "proximity": ("Close", *RANGE),
}
DEFAULTS = {
    "universe": "Nifty 500 member = 1 AND NSE equity = 1 AND ISIN match = 1",
    "liquidity": "Median turnover >= 10000000",
    "touches": "Daily low <= L + 0.10 * R",
    "rebound": "Between touches high >= L + 0.40 * R",
    "proximity": "Close >= L AND Close <= L + 0.15 * R",
}


@lru_cache(maxsize=256)
def expression(flag, text):
    return compile_expression(text, {field: field.lower().replace(" ", "_") for field in FIELDS[flag]})


class Discovery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    lookback: int = Field(default=20, ge=5, le=120)
    min_touches: int = Field(default=2, ge=2, le=20)
    touch_gap: int = Field(default=5, ge=2, le=119)
    minimum: int = Field(default=5, ge=2, le=5)
    formulas: dict[str, str] = Field(default_factory=lambda: dict(DEFAULTS))

    @model_validator(mode="after")
    def validate_formulas(self):
        if set(self.formulas) != set(FLAGS):
            raise ValueError("Provide one formula for each of the five discovery filters.")
        for flag, formula in self.formulas.items():
            try:
                expression(flag, formula)
            except ValueError as exc:
                raise ValueError(f"{flag}: {exc}") from None
        if 1 + (self.min_touches - 1) * self.touch_gap > self.lookback:
            raise ValueError("The lookback is too short for the selected touch count and spacing.")
        return self

    def indices(self):
        names = {node.id for node in ast.walk(expression("universe", self.formulas["universe"])) if isinstance(node, ast.Name)}
        return [n for n in INDEX_SIZES if f"_nifty_{n}_member" in names]

    def check(self, flag, **values):
        return evaluate(expression(flag, self.formulas[flag]), values)


def passed(flags, minimum):
    return sum(flags.get(key) is True for key in FLAGS) >= minimum


def at_close(pattern, price):
    if "discovery_flags" not in pattern:
        return bool(pattern.get("member") and pattern["low"] <= price <= pattern["low"] + .15*pattern["width"])
    flags = dict(pattern["discovery_flags"])
    flags["proximity"] = proximity(pattern, price)
    return passed(flags, pattern["minimum"])


def proximity(pattern, price):
    values = dict(close=price, l=pattern["low"], h=pattern["high"], r=pattern["high"]-pattern["low"])
    return evaluate(expression("proximity", pattern.get("close_formula", DEFAULTS["proximity"])), values)


def daily_pattern(bars, tick, isin, membership, rules):
    low = min(b["low"] for b in bars)
    high = max(b["high"] for b in bars)
    width = high - low
    span = dict(l=low, h=high, r=width)
    amounts = [b["close"] * b["volume"] for b in bars if b["volume"] is not None]
    complete_volume = len(amounts)==len(bars)
    turnover = median(amounts) if complete_volume else None
    liquid = rules.check("liquidity", median_turnover=turnover, mean_turnover=mean(amounts) if complete_volume else None,
                         median_volume=median(b["volume"] for b in bars) if complete_volume else None, **span)
    touches = [i for i,b in enumerate(bars) if rules.check("touches", daily_low=b["low"], daily_close=b["close"],
                                                           daily_high=b["high"], **span) is True]
    spaced = []
    for i in touches:
        if not spaced or i - spaced[-1] >= rules.touch_gap:
            spaced.append(i)
    peak = low
    rebound = False
    touch_days = set(touches)
    for first in touches:
        between_high = None
        for last in range(first+1, len(bars)):
            if last in touch_days and last-first >= rules.touch_gap:
                peak = max(peak, between_high)
                if not rebound:
                    rebound = rules.check("rebound", between_touches_high=between_high, **span) is True
            current_high = bars[last]["high"]
            between_high = current_high if between_high is None else max(between_high,current_high)
    flags = dict(universe=membership, liquidity=liquid, touches=width>0 and len(spaced)>=rules.min_touches,
                 rebound=width>0 and rebound)
    row = dict(flags, low=low, high=high)
    if width <= 0 or not tick or tick <= 0 or sum(v is True for v in flags.values())+1 < rules.minimum:
        return row, None
    pattern = dict(low=low, high=high, width=width, bounce=(peak-low)/width,
                   touches=[bars[i]["as_of"][:10] for i in spaced], turnover=turnover,
                   breakout=round(max(b["high"] for b in bars[-3:]) + tick, 6), tick=tick,
                   previous=bars[-1]["close"], stop=low-.1*width, target=high-.1*width,
                   member=membership, isin=isin, discovery_flags=flags, minimum=rules.minimum,
                   close_formula=rules.formulas["proximity"])
    return row, pattern
