"""Out-of-sample comparisons of saved outputs. No provider calls or order execution."""
from collections import defaultdict
from datetime import datetime, timezone
from statistics import mean

from sqlalchemy import select
from app.domains.runs.models import AutoRebalanceWorkflow as Workflow
from . import storage
from .storage import Stage
from zoneinfo import ZoneInfo


def sparse_agreement(rows, top=5):
    """Compare a balanced, lower-cost schedule to the actual full round robin."""
    from hashlib import sha256
    keys=sorted((r["listing"] for r in rows),key=lambda k:sha256(k.encode()).digest())
    if len(keys)<=16 or any(r.get("coverage")!="Complete" for r in rows):
        return None
    scores={}
    for r in rows:
        i=keys.index(r["listing"])
        opponents={keys[(i+d)%len(keys)] for d in (-4,-3,-2,-1,1,2,3,4)}
        chosen=[v["verdict"] for v in r["comparisons"] if v["opponent"] in opponents]
        if len(chosen)!=8 or "UNKNOWN" in chosen:
            return None
        scores[r["listing"]]=(chosen.count(r["listing"])+chosen.count("TIE")/2)/8
    full=sorted(rows,key=lambda r:(-r["score"],r["listing"]))[:top]
    sparse=sorted(keys,key=lambda k:(-scores[k],k))[:top]
    return {"full_pairs":len(keys)*(len(keys)-1)//2,"sample_pairs":4*len(keys),
            "top_overlap":len(set(sparse)&{r["listing"] for r in full}),"top_n":top}


def compare_dates(decisions, prices, top, cost_bps):
    benchmark = prices.get("NSE:NIFTYBEES",{})
    days=sorted(benchmark)
    results=[]
    for decision in decisions:
        eligible = {k:v for k,v in decision["signals"].items() if all(v.get(x) is not None for x in ("current","revised","pairwise"))}
        if len(eligible)<top:
            continue
        start=next((i for i,day in enumerate(days) if day>decision["day"]),len(days))
        # Reject a stale entry rather than silently jumping over a missing month of prices.
        if start==len(days) or (datetime.fromisoformat(days[start])-datetime.fromisoformat(decision["day"])).days>5:
            continue
        weights=decision["weights"]
        if sum(weights)<=0:
            continue
        def ranked(mode):
            def score(k):
                s=eligible[k]
                return s[mode] if mode!="combined" else (s["revised"]*weights[0]+s["pairwise"]*weights[1])/sum(weights)
            return sorted(eligible,key=lambda k:(-score(k),k))[:top]
        baskets={m:ranked(m) for m in ("current","revised","combined")}
        for weeks in (2,4,8,12):
            stop=start+weeks*5-1
            if stop>=len(days):
                continue
            window=days[start:stop+1]
            # Missing benchmark sessions cannot be treated as a full return horizon.
            if (datetime.fromisoformat(window[-1])-datetime.fromisoformat(window[0])).days > weeks*7+7:
                continue
            names=set().union(*baskets.values())
            if any(any(day not in prices.get(k,{}) for day in window) for k in names):
                continue
            breturn=benchmark[window[-1]]["close"]/benchmark[window[0]]["open"]-1
            added=set(baskets["combined"])-set(baskets["revised"])
            displaced=set(baskets["revised"])-set(baskets["combined"])
            def gain(k):
                return prices[k][window[-1]]["close"]/prices[k][window[0]]["open"]-1
            cutoff_effect=100*(mean(map(gain,added))-mean(map(gain,displaced))) if added and displaced else None
            for mode,names in baskets.items():
                curve=[1.0]
                for day in window:
                    curve.append(mean(prices[k][day]["close"]/prices[k][window[0]]["open"] for k in names))
                # Equal-weight entry and liquidation: one-way modeled costs on each leg.
                fee=cost_bps/10000
                curve[1:]=[v/(1+fee) for v in curve[1:]]
                curve[-1]*=1-fee
                peak=1.0
                dd=0.0
                for v in curve:
                    peak=max(peak,v)
                    dd=min(dd,v/peak-1)
                results.append({"sequence":decision["sequence"],"entry":window[0],"weeks":weeks,"variant":mode,
                                "net_return_pct":100*(curve[-1]-1),"excess_pct":100*(curve[-1]-1-breturn),
                                "drawdown_pct":100*dd,"top":names,"changed_at_cutoff":len(added),"cutoff_excess_pct":cutoff_effect})
    grouped=[]
    for weeks in (2,4,8,12):
        for mode in ("current","revised","combined"):
            rows=sorted((r for r in results if r["weeks"]==weeks and r["variant"]==mode),key=lambda r:r["entry"])
            turnover=[100*(1-len(set(a["top"])&set(b["top"]))/top) for a,b in zip(rows,rows[1:])]
            swaps=[r["cutoff_excess_pct"] for r in rows if r["cutoff_excess_pct"] is not None]
            grouped.append({"weeks":weeks,"variant":mode,"matured_cohorts":len(rows),
                            "mean_excess_pct":mean(r["excess_pct"] for r in rows) if rows else None,
                            "cutoff_changes":sum(r["changed_at_cutoff"] for r in rows) if mode=="combined" else None,
                            "mean_added_minus_displaced_pct":mean(swaps) if mode=="combined" and swaps else None,
                            "mean_net_pct":mean(r["net_return_pct"] for r in rows) if rows else None,
                            "worst_cohort_drawdown_pct":min((r["drawdown_pct"] for r in rows),default=None),
                            "mean_top_basket_turnover_pct":mean(turnover) if turnover else None})
    return grouped


async def evaluate(db, owner, portfolio, top, cost_bps):
    def scope(*cols):
        return select(*cols).select_from(Stage).join(Workflow).where(Workflow.user_id==owner,Workflow.portfolio==portfolio)
    data=Stage.summary_json
    packets=(await db.execute(scope(data["revision_id"].as_integer(),data["research"])
             .where(storage.of_kind("packet")).order_by(Stage.id.desc()).limit(120))).all()
    research_by_rev=dict(packets)
    prices=defaultdict(dict)
    for _,packet in reversed(packets):
        for k,obs in {**packet["listings"],"NSE:NIFTYBEES":packet["benchmark"]}.items():
            for bar in obs:
                if bar.get("kind")=="daily_bar":
                    prices[k].setdefault(bar["as_of"][:10],bar)
    finals=(await db.execute(scope(Workflow.sequence,Stage.created_at,data["revision_id"].as_integer(),
                data["result"]["attempts"],data["result"]["policy"]["weights"])
            .where(storage.of_kind("final")).order_by(Stage.id.desc()).limit(150))).all()
    unique={}
    for seq,stamp,rev,refs,weights in finals:
        if refs and refs.get("technical") and refs.get("pairwise") and rev in research_by_rev:
            unique[seq]=(stamp,rev,refs,weights)
    ids={refs[c] for _,_,refs,_ in unique.values() for c in ("technical","pairwise")}
    outputs=dict((await db.execute(scope(Stage.id,data["result"]["rows"]).where(Stage.id.in_(ids)))).all()) if ids else {}
    decisions=[]
    for seq,(stamp,rev,refs,weights) in unique.items():
        technical=outputs.get(refs["technical"]) or []
        pairs={r["listing"]:r for r in outputs.get(refs["pairwise"]) or []}
        signals={}
        for row in technical:
            key=row["listing"]
            other=pairs.get(key,{})
            if other.get("coverage")!="Complete":
                continue
            signals[key]={"current":row.get("score"),"revised":(row.get("features") or {}).get("shadow_score"),"pairwise":other.get("score")}
        day=(stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)).astimezone(ZoneInfo("Asia/Kolkata")).date().isoformat()
        decisions.append({"sequence":seq,"day":day,"signals":signals,"weights":[weights["technical"],weights["pairwise"]]})
    return {"eligible_workflows":len(decisions),"top_n":top,"one_way_cost_bps":cost_bps,"benchmark":"NSE:NIFTYBEES",
            "rows":compare_dates(decisions,prices,top,cost_bps)}
