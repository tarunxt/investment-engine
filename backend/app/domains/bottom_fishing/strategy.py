"""Version 1 deterministic NSE cash-equity paper strategy, all timestamps IST."""
from math import floor
from statistics import median

WEIGHTS = dict(bounce=20, proximity=15, strength=15, recovery=10, roce=12, sales=10, profit=10, leverage=8)
# Estimated charges + slippage on each side for the simulation.
COST = 0.002


def clamp(value):
    return max(0.0, min(1.0, value))


def support_metrics(bars):
    low = min(b["low"] for b in bars)
    high = max(b["high"] for b in bars)
    width = high - low
    turnover = median(b["close"] * (b["volume"] or 0) for b in bars)
    touches = [i for i, b in enumerate(bars) if b["low"] <= low + .1 * width]
    pairs = [(max(b["high"] for b in bars[i+1:j]), i, j)
             for i in touches for j in touches if j-i >= 5]
    return low, high, turnover, max(pairs, default=None)


def support(bars, tick, metrics=None):
    if len(bars) != 20 or not tick or tick <= 0:
        return None
    low, high, turnover, pair = metrics or support_metrics(bars)
    width = high - low
    if width <= 0 or turnover < 10_000_000 or pair is None:
        return None
    peak, i, j = pair
    if peak < low + .4 * width:
        return None
    return dict(low=low, high=high, width=width, bounce=(peak-low)/width,
                touches=[bars[k]["as_of"][:10] for k in (i,j)], turnover=turnover,
                breakout=round(max(b["high"] for b in bars[-3:]) + tick, 6),
                tick=tick, previous=bars[-1]["close"], stop=low-.1*width, target=high-.1*width)


def evaluate(setup, price, previous, benchmark_return, facts, weights):
    low, width = setup["low"], setup["width"]
    risk = price*(1+COST) - setup["stop"]*(1-COST)
    reward = setup["target"]*(1-COST) - price*(1+COST)
    maximum = (setup["target"] + 2*setup["stop"])*(1-COST)/(3*(1+COST))
    result = dict(price=price, stop=setup["stop"], target=setup["target"], breakout=setup["breakout"],
                  max_buy=round(floor(maximum/setup["tick"])*setup["tick"], 6), risk=risk,
                  rr=round(reward/risk, 4) if risk > 0 else None)
    if setup.get("invalid"):
        return dict(result, reason="Support broken")
    if not facts or benchmark_return is None:
        return dict(result, reason="Missing fundamentals or benchmark")
    factors = dict(bounce=setup["bounce"], proximity=1-(setup["discovery"]-low)/(.15*width),
                   strength=.5+((price/setup["previous"]-1)-benchmark_return)/.04,
                   recovery=(price-setup["discovery"])/(.25*width), roce=facts["roce"]/25,
                   sales=facts["sales"]/25, profit=facts["profit"]/25, leverage=1-facts["leverage"]/2)
    points = {k:round(clamp(v)*weights[k], 4) for k,v in factors.items()}
    score = round(sum(points.values()), 2)
    if score < 70:
        reason = "Score below 70"
    elif previous is None or not previous < setup["breakout"] <= price:
        reason = "Waiting for fresh breakout"
    elif risk <= 0 or price > result["max_buy"]:
        reason = "Reward/risk below 2 after costs"
    else:
        reason = "Qualified"
    return dict(result, score=score, points=points, reason=reason, financials=facts)


def quantity(capital, positions, pending, price, risk, realized=0):
    exposure = [*positions.values(), *pending.values()]
    reserved = sum(p["qty"]*p["risk"] for p in exposure)
    cash = capital + realized - sum(p["qty"]*p["price"]*(1+COST) for p in exposure)
    if risk <= 0 or price <= 0:
        return 0
    return max(0, floor(min(10_000/price, cash/(price*(1+COST)), capital*.005/risk,
                            (capital*.015-reserved)/risk)))


def exit_fill(position, bar, time_exit):
    if bar["low"] <= position["stop"]:
        return min(bar["open"], position["stop"]), "Stop"
    if bar["high"] >= position["target"]:
        return position["target"], "Target"
    if time_exit:
        return bar["close"], "Session 15"
    return None
