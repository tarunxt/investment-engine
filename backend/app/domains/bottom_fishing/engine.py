"""Single paper cycle. No broker order client or execution credentials."""
from datetime import datetime, time, timedelta
from .market import BENCH, INDIA
from .strategy import COST, evaluate, quantity, exit_fill


def roll(state, stamp):
    day = stamp.date().isoformat()
    if state.get("day") != day:
        return dict(day=day, setups={}, rows=[], scans=[], positions=state.get("positions",{}), pending={},
                    realized=state.get("realized",0), closed=state.get("closed",[]), seen=[])
    return state


def close_position(state, symbol, price, why, end):
    p = state["positions"].pop(symbol)
    pnl = round(p["qty"]*(price*(1-COST)-p["price"]*(1+COST)),2)
    state["closed"] = [*state["closed"][-99:], dict(symbol=symbol, qty=p["qty"], entry=p["entry"],
                       end=end, price=price, reason=why, pnl=pnl)]
    state["realized"] = round(state["realized"]+pnl,2)


def paper_cycle(state, settings, stamp, levels, series, fundamentals, benchmark_close, screen, calendar, *, preview=False):
    at = stamp.isoformat()
    setups, positions = state["setups"],state["positions"]
    if not preview:
        state["pending"] = {}
    benchmark = series.get(BENCH,[])
    benchmark_return = None
    if benchmark_close and benchmark and benchmark[-1]["end"]==at:
        benchmark_return = benchmark[-1]["close"]/benchmark_close-1
    for k,p in ([] if preview else list(positions.items())):
        for b in series.get(k,[]):
            if b["end"]<=p["checked"]:
                continue
            end = datetime.fromisoformat(b["end"])
            age = sum(p["entry"][:10]<=day<=end.date().isoformat() for day in calendar)
            due = age>15 or (age==15 and end.time()>=time(15))
            # A five-minute bar straddling entry can contain pre-entry extremes.
            observed = b
            if end-timedelta(minutes=5) < datetime.fromisoformat(p["entry"]):
                observed = dict(b,open=b["close"],low=b["close"],high=b["close"])
            hit = exit_fill(p,observed,due)
            p["checked"] = b["end"]
            if hit:
                price,why = hit
                close_position(state,k,price,why,b["end"])
                break
    if screen:
        state["scans"].append(dict(at=at, **screen))
    rows = []
    for k in sorted(set(setups)|set(levels)):
        bars = series.get(k,[])
        current = bars[-1] if bars and bars[-1]["end"]==at else None
        pattern = levels.get(k)
        if screen and k not in setups and pattern and current:
            price = current["close"]
            if pattern["low"]<=price<=pattern["low"]+.15*pattern["width"]:
                setups[k] = dict(pattern, discovery=price, discovered=at)
        s = setups.get(k)
        sources = ["bottom"] if s and s["member"] else []
        if s and any(b["end"]>s["discovered"] and b["close"]<s["low"] for b in bars):
            s["invalid"] = True
        if not set(sources).intersection(settings["inputs"]):
            continue
        row = dict(symbol=k, sources=sources)
        if not s:
            row["reason"] = "No qualifying bottom setup"
        elif current is None:
            row["reason"] = "Missing current closed candle"
        else:
            prev = bars[-2]["close"] if len(bars)>1 and datetime.fromisoformat(bars[-2]["end"])==stamp-timedelta(minutes=5) else None
            row.update(evaluate(s,current["close"],prev,benchmark_return,fundamentals.get(k),settings["weights"]))
            row["discovered"] = s["discovered"]
        rows.append(row)
    rows.sort(key=lambda r:(-(r.get("score") or 0),-(r.get("rr") or 0),-setups.get(r["symbol"],{}).get("turnover",0),r["symbol"]))
    state.update(rows=rows, at=at, status="completed", error=None)
    if not preview:
        size_entries(state, settings, stamp)
    return state


def size_entries(state, settings, stamp, *, preview=False):
    positions = state["positions"]
    reservations = dict(state["pending"]) if preview else state["pending"]
    for row in state["rows"]:
        k = row["symbol"]
        if row["reason"]!="Qualified":
            continue
        if k in positions or k in reservations or k in state["seen"]:
            row["reason"] = "Already held or attempted today"
        elif not preview and not time(9,30)<=stamp.time()<=time(14,45):
            row["reason"] = "Outside entry window"
        else:
            qty = quantity(settings["capital"],positions,reservations,row["price"],row["risk"],state["realized"])
            if qty:
                reservations[k] = dict(price=row["price"], risk=row["risk"], qty=qty)
                if preview:
                    row.update(reason="Proposed buy", qty=qty)
                    continue
                reservations[k].update(stop=row["stop"], target=row["target"], created=datetime.now(INDIA).isoformat(), isin=state["setups"][k]["isin"])
                state["seen"].append(k)
                row.update(reason="Paper limit pending", qty=qty)
            else:
                row["reason"] = "Cash or planned-risk limit"
