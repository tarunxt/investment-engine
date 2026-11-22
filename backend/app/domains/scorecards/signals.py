"""Point-in-time inputs for the India equity scorecards."""
import math
import re
from datetime import datetime
from statistics import mean, pstdev

from .prompts import CATALOGUE


def daily_series(records, cutoff):
    """Conflicting observations or a likely change of price scale need verification."""
    by_day = {}
    boundary = datetime.fromisoformat(cutoff)
    for bar in records:
        if bar.get("kind") != "daily_bar":
            continue
        try:
            stamp = datetime.fromisoformat(bar["as_of"])
            if not stamp.tzinfo or stamp > boundary:
                continue
            values = tuple(float(bar[key]) for key in ("open", "high", "low", "close", "volume"))
            op, hi, lo, close, volume = values
            if not all(map(math.isfinite, values)) or not (0 < lo <= min(op, close) <= max(op, close) <= hi) or volume < 0:
                continue
        except (KeyError, TypeError, ValueError):
            continue
        day = stamp.date().isoformat()
        if day in by_day and by_day[day][0] != values:
            return [], "Conflicting candles for the same session"
        by_day[day] = (values, {**bar, **dict(zip(("open","high","low","close","volume"), values))})
    series = [by_day[day][1] for day in sorted(by_day)]
    if any(max(a["close"], b["open"]) / min(a["close"], b["open"]) > 1.45 for a,b in zip(series,series[1:])):
        return [], "Price scale requires verification"
    return series, None


def features(records, cutoff, benchmark=()):
    bars, issue = daily_series(records, cutoff)
    index, _ = daily_series(benchmark, cutoff)
    out = {"sessions":len(bars), "issue":issue, "as_of":None, "close":None,
           "return_5_pct":None, "relative_20_pct":None, "relative_volume_20":None,
           "volatility_20_pct":None, "distance_sma50_pct":None, "shadow_score":None}
    if not bars:
        out["issue"] = issue or "Missing candles"
        return out
    close = bars[-1]["close"]
    out.update(as_of=bars[-1]["as_of"], close=close)
    if (datetime.fromisoformat(cutoff)-datetime.fromisoformat(out["as_of"])).days > 5:
        out["issue"] = "Stale candles"
        return out
    days = {r["as_of"][:10] for r in bars}
    if len(index)>=6 and not {r["as_of"][:10] for r in index[-6:]}.issubset(days):
        out["issue"] = "Missing a recent benchmark session"
        return out
    if len(bars) >= 6:
        out["return_5_pct"] = 100*(close/bars[-6]["close"]-1)
    else:
        out["issue"] = "Fewer than six closing prices"
    if len(bars) >= 21:
        closes = [r["close"] for r in bars[-21:]]
        returns = [b/a-1 for a,b in zip(closes,closes[1:])]
        vol = mean(r["volume"] for r in bars[-21:-1])
        out["relative_volume_20"] = bars[-1]["volume"]/vol if vol else None
        out["volatility_20_pct"] = 100*pstdev(returns)
        sessions = [r["as_of"][:10] for r in bars[-21:]]
        index_dates = [r["as_of"][:10] for r in index[-21:]]
        if sessions == index_dates:
            out["relative_20_pct"] = 100*(close/closes[0]-index[-1]["close"]/index[-21]["close"])
    if len(bars) >= 50:
        out["distance_sma50_pct"] = 100*(close/mean(r["close"] for r in bars[-50:])-1)
    # An explicitly experimental score. Scale by recent daily volatility over each horizon.
    vol = out["volatility_20_pct"]
    horizons = (("return_5_pct",5), ("relative_20_pct",20), ("distance_sma50_pct",50))
    if vol and all(out[k] is not None for k,_ in horizons):
        out["shadow_score"] = 50+50*mean(math.tanh(out[k]/(vol*math.sqrt(days))) for k,days in horizons)
    return out


def setup_state(rows, signal):
    if not rows:
        return {"setup":"Unassessed", "entry":"Unassessed"}
    row = rows[0]
    label = str(row.get("Primary Setup", ""))
    record = CATALOGUE.get(re.sub(r"\s*\([\d.]+\)$", "", label))
    rating = record["confidence"] if record else None
    state = {"setup":label or "None identified", "catalogue_rating":rating,
             "entry":"Unassessed", "trigger":None, "invalidation":None}
    price = signal.get("close")
    if rating is None or price is None or signal.get("issue"):
        return state
    try:
        trigger, stop = (float(row[k]) for k in ("Trigger Level","Invalidation Level"))
    except (KeyError, TypeError, ValueError):
        return state
    if not all(math.isfinite(x) and x > 0 for x in (trigger,stop)) or trigger == stop:
        return state
    direction = str(row.get("Bias","")).lower()
    if (direction, trigger > stop) not in {("bullish",True), ("bearish",False)}:
        return state
    sign = 1 if direction == "bullish" else -1
    state.update(trigger=trigger, invalidation=stop, entry="Invalidated" if sign*(price-stop)<=0
                 else "Triggered at close" if sign*(price-trigger)>=0 else "Waiting for trigger")
    return state
