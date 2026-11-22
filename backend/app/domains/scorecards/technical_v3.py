"""Frozen twenty-session directional evidence. All weights are fractions of the full card."""
import math
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from statistics import mean, median

WEIGHTS = {"Trend": .25, "Momentum": .20, "Relative strength": .20, "Volume": .15, "Setup": .20}
BENCHMARK = "NSE:NIFTYBEES"


def display(value):
    return float(Decimal(str(value)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP))


def clip(value):
    return min(1., max(-1., value))


def robust_scale(values):
    center = median(values)
    return 1.4826 * median(abs(v-center) for v in values)


def summarize(factors, hard_issue=None):
    observed = {k: f["value"] for k, f in factors.items() if f["value"] is not None}
    pct = sum(round(100*WEIGHTS[k]) for k in observed)
    subtotal = sum(WEIGHTS[k]*v for k, v in observed.items())
    eligible = {"Trend", "Momentum"} <= observed.keys() and len(observed) >= 4 and pct >= 75 and not hard_issue
    score = display(subtotal + (100-pct)/2) if eligible else None
    return {"score": score, "coverage_pct": pct,
            "coverage": "Insufficient data" if not eligible else "Complete" if pct == 100 else "Provisional",
            "range": [display(subtotal), display(subtotal+100-pct)] if eligible else None,
            "direction": "Unassessed" if score is None else "Extremely bearish" if score < 20 else
                         "Bearish" if score < 45 else "Neutral / mixed" if score <= 55 else
                         "Bullish" if score <= 80 else "Extremely bullish"}


def normalise(records, sessions, actions, cutoff):
    """Use raw venue bars on a common split/bonus basis; invalidate conflicted sessions."""
    prices, faults = {}, {}
    allowed = set(sessions)
    end = datetime.fromisoformat(cutoff)
    for item in records:
        if item.get("kind") != "daily_bar":
            continue
        day = item["as_of"][:10]
        if day not in allowed:
            continue
        try:
            stamp = datetime.fromisoformat(item["as_of"])
            if stamp.tzinfo is None or stamp > end:
                continue
            op, hi, lo, cl = (float(item[k]) for k in ("open","high","low","close"))
            if not all(map(math.isfinite,(op,hi,lo,cl))) or not 0 < lo <= min(op,cl) <= max(op,cl) <= hi:
                raise ValueError("Invalid OHLC")
            vol = item.get("volume")
            if vol is not None and (not math.isfinite(float(vol)) or float(vol)<0):
                vol = None
            ratio = 1.
            for action in actions:
                if day < action["date"] <= sessions[-1]:
                    if not action.get("multiplier") or item.get("basis") == "unverified-provider":
                        raise ValueError("Corporate action price basis unresolved")
                    ratio *= action["multiplier"]
            bar = (op/ratio, hi/ratio, lo/ratio, cl/ratio, None if vol is None else float(vol)*ratio)
            if day in prices and prices[day] != bar:
                raise ValueError("Conflicting daily observations")
            prices[day] = bar
        except (ValueError, KeyError, TypeError, OverflowError) as exc:
            faults[day] = str(exc)
    for day in faults:
        prices.pop(day, None)
    return prices, faults


def calculate(listing, cutoff, sessions, series, benchmark, *, tick, sources, issues, benchmark_sessions=None):
    bars, faults = series
    index, _ = benchmark
    factors = {key: {"weight": w, "value": None, "points": None, "inputs": {}, "reason": None} for key,w in WEIGHTS.items()}
    variants = {}
    flags = []
    entry = {"setup": "20-session range", "entry": "Unassessed"}
    def window(key, count, data):
        days = sessions[-count:]
        missing = next((d for d in days if d not in data), None)
        if len(days) < count or missing:
            factors[key]["reason"] = (f"{faults.get(missing, 'Missing session')} · {missing}" if missing else f"{count} sessions required")
            return []
        return [data[d] for d in days]
    def record(name, value, **inputs):
        factors[name].update(value=value, points=WEIGHTS[name]*(value-50), inputs=inputs)
    trend = window("Trend",55,bars)
    if trend and tick and math.isfinite(tick) and tick > 0:
        ranges=[max(b[1]-b[2],abs(b[1]-a[3]),abs(b[2]-a[3])) for a,b in zip(trend[-22:-2],trend[-21:-1])]
        unit=max(2*tick,median(ranges))
        now, before = mean(b[3] for b in trend[-50:]), mean(b[3] for b in trend[:-5])
        value=50+25*(clip((trend[-1][3]-now)/(2*unit))+clip((now-before)/unit))
        record("Trend",value,close=trend[-1][3],sma50=now,prior_sma50=before,range_unit=unit,tick=tick)
    elif trend:
        factors["Trend"]["reason"]="Verified listing tick unavailable"
    mom=window("Momentum",26,bars)
    if mom:
        raw_noise=robust_scale([math.log(b[3]/a[3]) for a,b in zip(mom[:20],mom[1:21])])
        noise=max(.005,raw_noise)
        move=math.log(mom[-1][3]/mom[-6][3])
        record("Momentum",50+50*clip(move/(2*noise*math.sqrt(5))),log_return_5=move,daily_scale=noise,raw_scale=raw_noise)
    rs=window("Relative strength",41,bars)
    reference=window("Relative strength",41,index)
    if rs and reference:
        if benchmark_sessions is not None and sessions[-41:] != benchmark_sessions[-41:]:
            factors["Relative strength"]["reason"]="Stock and benchmark session calendars differ"
        elif any(v[4] == 0 for v in reference):
            factors["Relative strength"]["reason"]="Benchmark has a no-trade session"
        else:
            excess=[math.log(b[3]/a[3])-math.log(y[3]/x[3]) for a,b,x,y in zip(rs,rs[1:],reference,reference[1:])]
            raw_tracking=robust_scale(excess[:20])
            tracking=max(.005,raw_tracking)
            move=sum(excess[-20:])
            record("Relative strength",50+50*clip(move/(2*tracking*math.sqrt(20))),excess_log_return_20=move,tracking_scale=tracking,raw_scale=raw_tracking)
    volume=window("Volume",25,bars)
    if volume:
        volumes=[b[4] for b in volume]
        baseline=median(volumes[:20]) if None not in volumes else 0
        if baseline and sum(volumes[-5:])>0:
            capped=[min(v,2*baseline) for v in volumes[-5:]]
            signed=sum(v*((b[3]>a[3])-(b[3]<a[3])) for v,a,b in zip(capped,volume[-6:-1],volume[-5:]))
            divisor=max(5*baseline,sum(capped))
            signs=[(b[3]>a[3])-(b[3]<a[3]) for a,b in zip(volume[-6:-1],volume[-5:])]
            for cap,label in ((1,"half"),(4,"double")):
                sizes=[min(v,cap*baseline) for v in volumes[-5:]]
                adjusted=50+50*sum(v*sign for v,sign in zip(sizes,signs))/max(5*baseline,sum(sizes))
                variants["volume cap "+label]={"Volume":adjusted}
            record("Volume",50+50*signed/divisor,median_volume=baseline,signed_volume=signed,capped_total=sum(capped),divisor=divisor)
        else:
            factors["Volume"]["reason"]="Missing volume or no usable trading-volume baseline"
    setup=window("Setup",22,bars)
    if setup:
        upper,lower=max(b[1] for b in setup[:-2]),min(b[2] for b in setup[:-2])
        a,b=setup[-2][3],setup[-1][3]
        if upper<=lower:
            factors["Setup"]["reason"]="Degenerate prior range"
        else:
            value=100 if b>upper and a>upper else 75 if b>upper else 0 if b<lower and a<lower else 25 if b<lower else 50
            state={100:"Held above",75:"Triggered above",0:"Held below",25:"Triggered below"}.get(value,"Failed" if a>upper or a<lower else "Waiting")
            record("Setup",value,upper=upper,lower=lower,previous_close=a,decision_close=b)
            entry.update(entry=state,upper=upper,lower=lower,invalidation=upper if b>upper else lower if b<lower else None)
            if (a<lower and b>upper) or (a>upper and b<lower):
                flags.append("Opposite breakout failed")
    recent=[bars.get(d) for d in sessions[-20:]]
    if len(recent)==20 and all(recent):
        if sum(bool(b[4]) for b in recent)<15 or len({b[3] for b in recent[-5:]})==1:
            flags.append("Liquidity review")
    day=sessions[-1] if sessions else None
    hard=(issues[0] if issues else "Trading calendar unavailable" if not day else
          faults.get(day,"Decision-session candle missing") if day not in bars else
          "Decision-session trading volume unverified" if bars[day][4] is None else "No trade on decision session" if bars[day][4]==0 else None)
    summary=summarize(factors,hard)
    sensitivities={}
    if summary["score"] is not None:
        for floor,label in ((.0025,"half"),(.01,"double")):
            alternate={}
            for key,field,horizon in (("Momentum","log_return_5",5),("Relative strength","excess_log_return_20",20)):
                inputs=factors[key]["inputs"]
                if field in inputs:
                    alternate[key]=50+50*clip(inputs[field]/(2*max(floor,inputs["raw_scale"])*math.sqrt(horizon)))
            variants["daily floor "+label]=alternate
        for key in WEIGHTS:
            variants["omit "+key]={key:50}
        for label,overrides in variants.items():
            sensitivities[label]=display(50+sum(WEIGHTS[key]*(overrides.get(key,f["value"])-50)
                for key,f in factors.items() if f["value"] is not None))
    missing=[f'{k}: {v["reason"]}' for k,v in factors.items() if v["reason"]]
    return {**summary,"version":3,"listing":listing,"as_of":cutoff,"session":day,"horizon":20,"benchmark":BENCHMARK,
            "factors":factors,"readiness":entry,"sources":sources,"flags":flags,"reason":" · ".join(dict.fromkeys(([hard] if hard else [])+issues+missing)),
            "sensitivities":sensitivities,
            "turnover":median(b[3]*b[4] for b in recent) if len(recent)==20 and all(b and b[4] is not None for b in recent) else None,
            "momentum_baseline":math.expm1(factors["Momentum"]["inputs"]["log_return_5"]) if factors["Momentum"]["value"] is not None else None}
