"""Paired forward evaluation on frozen Stage 2 dates. A missing label is never a loss or a win."""
import asyncio
import calendar
import random
from collections import defaultdict
from bisect import bisect_left
from datetime import date, timedelta
from math import sqrt
from statistics import mean, median
from sqlalchemy import select

from . import storage
from .storage import Stage
from app.domains.runs.models import AutoRebalanceWorkflow as Workflow

NAMES=("candidate","legacy","momentum")


def ranks(values):
    order=sorted(range(len(values)),key=values.__getitem__)
    out=[0.]*len(values)
    left=0
    while left<len(order):
        right=left+1
        while right<len(order) and values[order[right]]==values[order[left]]:
            right+=1
        for i in order[left:right]:
            out[i]=(left+right-1)/2
        left=right
    return out


def correlation(x,y):
    a,b=ranks(x),ranks(y)
    center=(len(a)-1)/2
    den=sqrt(sum((v-center)**2 for v in a)*sum((v-center)**2 for v in b))
    return sum((v-center)*(w-center) for v,w in zip(a,b))/den if den else None


def interval(values, length):
    if len(values)<2*length:
        return None
    rng=random.Random(205003)
    sample=[]
    for _ in range(1000):
        draw=[]
        while len(draw)<len(values):
            i=rng.randrange(len(values)-length+1)
            draw.extend(values[i:i+length])
        sample.append(mean(draw[:len(values)]))
    sample.sort()
    return [sample[24],sample[974]]


def balanced(calls):
    positive=[p for p,y in calls if y]
    negative=[not p for p,y in calls if not y]
    return (mean(positive)+mean(negative))/2 if positive and negative else None


def report(cohorts, *, sensitivities=False):
    expected=scored=legacy_scored=labeled=0
    daily=[]
    variant_ics=defaultdict(list)
    by_band=defaultdict(list)
    paired_calls={name:[] for name in ("candidate","legacy")}
    slices=defaultdict(list)
    directional=correct=unknown_calls=0
    for day,rows in sorted(cohorts.items()):
        unique={}
        for r in rows:
            expected+=1
            scored+=r["candidate"] is not None
            legacy_scored+=r["legacy"] is not None
            gain=r["outcome"]
            labeled+=gain is not None
            v=r["candidate"]
            if v is not None and (v>55 or v<45):
                directional+=1
                if gain is None:
                    unknown_calls+=1
                else:
                    correct+=(v>55)==(gain>0)
            if v is not None and gain is not None:
                by_band[r["direction"]].append(gain)
                for key in ("coverage","venue","regime","liquidity","corporate_actions","provider","volatility"):
                    slices[(key,r.get(key,"Unknown"))].append(gain)
            issuer=r.get("issuer")
            if issuer:
                old=unique.get(issuer)
                if not old or (-(r.get("turnover") or 0),r["listing"])<(-(old.get("turnover") or 0),old["listing"]):
                    unique[issuer]=r
        common=[r for r in unique.values() if r["outcome"] is not None and all(r[n] is not None for n in NAMES)]
        if len(common)<5:
            continue
        gains=[r["outcome"] for r in common]
        ic={n:correlation([r[n] for r in common],gains) for n in NAMES}
        if sensitivities:
            for variant in sorted({v for r in common for v in r.get("sensitivities",{})}):
                sample=[r for r in common if r.get("sensitivities",{}).get(variant) is not None]
                if len(sample)<5:
                    continue
                outcomes=[r["outcome"] for r in sample]
                base=correlation([r["candidate"] for r in sample],outcomes)
                alt=correlation([r["sensitivities"][variant] for r in sample],outcomes)
                if base is not None and alt is not None:
                    variant_ics[variant].append(alt-base)
        if all(v is not None for v in ic.values()):
            daily.append({"date":day,**ic})
        for r in common:
            if all(r[n]<45 or r[n]>55 for n in paired_calls):
                for n in paired_calls:
                    paired_calls[n].append((r[n]>55,r["outcome"]>0))
    intervals={n:{str(b):interval([v["candidate"]-v[n] for v in daily],b) for b in (20,40)} for n in NAMES[1:]}
    accuracy={n:balanced(v) for n,v in paired_calls.items()}
    return {"expected":expected,"scored":scored,"legacy_scored":legacy_scored,"labeled":labeled,"unknown_outcomes":expected-labeled,
            "dates":len(cohorts),"qualifying_dates":len(daily),"omitted_dates":len(cohorts)-len(daily),
            "mean_rank_ic":{n:mean(v[n] for v in daily) if daily else None for n in NAMES},
            "paired_lift_95":intervals,"balanced_accuracy":accuracy,"common_directional_calls":len(paired_calls["legacy"]),
            "always_up_balanced_accuracy":.5 if accuracy["legacy"] is not None else None,
            "directional_calls":directional,"hit_rate_bounds":[correct/directional,(correct+unknown_calls)/directional] if directional else None,
            "sensitivity_rank_ic_change":{k:{"paired_dates":len(v),"mean_change":mean(v)} for k,v in variant_ics.items()},
            "bands":{k:{"n":len(g),"up_rate":mean(v>0 for v in g),"median_return":median(g)} for k,g in by_band.items()},
            "slices":[{"by":k,"value":v,"n":len(g),"up_rate":mean(x>0 for x in g),"median_return":median(g)} for (k,v),g in slices.items()]}


def add_months(day, months):
    m=day.month-1+months
    y=day.year+m//12
    return date(y,m%12+1,min(day.day,calendar.monthrange(y,m%12+1)[1]))


def calibration(earlier, later):
    """Train monotonic pooled proportions on the validation block, then score the sealed test once."""
    def observations(block):
        data=[]
        for day,items in block.items():
            seen=set()
            for r in sorted(items,key=lambda r:(-(r.get("turnover") or 0),r["listing"])):
                issuer=r.get("issuer")
                if issuer and issuer not in seen:
                    seen.add(issuer)
                    if r["candidate"] is not None and r["outcome"] is not None:
                        data.append((day,r["candidate"],int(r["outcome"]>0)))
        return data
    train,test=observations(earlier),observations(later)
    result={"status":"Insufficient matured observations","training_rows":len(train),"test_rows":len(test),"bins":[]}
    if any(len({day for day,_,_ in block})<30 or len({y for _,_,y in block})<2 for block in (train,test)):
        return result
    groups=defaultdict(list)
    for _,score,y in train:
        groups[score].append(y)
    pools=[]
    for score,ys in sorted(groups.items()):
        pools.append((score,sum(ys),len(ys)))
        while len(pools)>1 and pools[-2][1]/pools[-2][2]>pools[-1][1]/pools[-1][2]:
            end,w,n=pools.pop()
            _,previous_w,previous_n=pools.pop()
            pools.append((end,w+previous_w,n+previous_n))
    ends=[v[0] for v in pools]
    prior=mean(y for _,_,y in train)
    errors=[]
    bins=defaultdict(list)
    for _,score,y in test:
        _,w,n=pools[min(bisect_left(ends,score),len(pools)-1)]
        probability=w/n
        errors.append((probability-y)**2)
        bins[min(9,int(probability*10))].append((probability,y))
    for bucket,items in sorted(bins.items()):
        n=len(items)
        observed=mean(y for _,y in items)
        z=1.96
        center=(observed+z*z/(2*n))/(1+z*z/n)
        radius=z*sqrt(observed*(1-observed)/n+z*z/(4*n*n))/(1+z*z/n)
        result["bins"].append({"decile":bucket,"n":n,"predicted":mean(p for p,_ in items),"observed":observed,
                               "wilson_95":[max(0.,center-radius),min(1.,center+radius)]})
    return {**result,"status":"Held-out evaluation","brier":mean(errors),"historical_up_rate":prior,
            "baseline_brier":mean((prior-y)**2 for _,_,y in test)}


def assessment(cohorts, as_of):
    # Fix the time blocks before outcomes mature. A rolling last-six-month "test" peeks on every run.
    first=date.fromisoformat(min(cohorts)) if cohorts else as_of
    validation_start=add_months(first,24)
    holdout=add_months(first,30)
    end=add_months(first,36)
    def block(start,stop):
        return {d:[r if r.get("label_end") and r["label_end"]<stop.isoformat() else {**r,"outcome":None}
                   for r in rows] for d,rows in cohorts.items() if start.isoformat()<=d<stop.isoformat()}
    development=block(first,validation_start)
    validation=block(validation_start,holdout)
    val=report(validation,sensitivities=True)
    # Reveal the reserved test only after its last twenty-session label can mature.
    mature=as_of>=end+timedelta(days=40)
    held=block(holdout,end) if mature else {}
    test=report(held)
    bounds=test["paired_lift_95"]
    acc=test["balanced_accuracy"]
    passed=(mature and test["qualifying_dates"]>=30 and test["scored"]>=test["legacy_scored"]
            and all(v and v[0]>0 for d in bounds.values() for v in d.values())
            and acc["legacy"] is not None and acc["candidate"] is not None and acc["candidate"]>=acc["legacy"])
    return {"version":3,"status":"Validated" if passed else "Unproven","promoted":bool(passed),
            "validation_start":str(validation_start),"holdout_start":str(holdout),"holdout_end_exclusive":str(end),
            "monitoring":report({d:rows for d,rows in cohorts.items() if d<holdout.isoformat()}),
            "development_sensitivities":report(development,sensitivities=True)["sensitivity_rank_ic_change"],
            "calibration":calibration(validation,held),"validation":val,"holdout":test,"holdout_open":mature}


def execution_review(cohorts, observations):
    """Long-only realised round trips with dated per-share costs and unadjusted fill prices."""
    remaining={(d,r["listing"]):r for d,rows in cohorts.items() for r in rows if r["candidate"] is not None and r["candidate"]>55}
    statuses=defaultdict(int)
    gains=[]
    slips=[]
    for o in observations:
        row=remaining.pop((o.decision.isoformat(),o.listing),None)
        if row is None:
            statuses["unmatched"]+=1
            continue
        if o.status!="filled":
            statuses[o.status]+=1
            continue
        # A recorded fill confirms execution. Require the prescribed dates and comparable share units.
        if not o.entry_session or not o.exit_session or o.entry_session.isoformat()!=row["entry_session"] or o.exit_session.isoformat()!=row["label_end"] or not row["share_multiplier"]:
            statuses["unverified"]+=1
            continue
        if any(v is None for v in (o.entry_fill,o.exit_fill,o.entry_reference,o.exit_reference,o.entry_fees_per_share,o.exit_fees_per_share)):
            statuses["unverified"]+=1
            continue
        ratio=row["share_multiplier"]
        gains.append((o.exit_fill-o.exit_fees_per_share)*ratio/(o.entry_fill+o.entry_fees_per_share)-1)
        slips.append(((o.entry_fill-o.entry_reference)+(o.exit_reference-o.exit_fill)*ratio)/o.entry_reference)
        statuses["filled"]+=1
    return {"eligible_long_signals":len(remaining)+sum(v for k,v in statuses.items() if k!="unmatched"),
            **{k:statuses[k] for k in ("filled","skipped","unfilled","unverified","unmatched")},
            "without_execution_record":len(remaining),"mean_net_return":mean(gains) if gains else None,
            "mean_slippage_fraction_of_entry":mean(slips) if slips else None}


async def evaluate(db, owner, as_of, executions=None):
    def scoped(*cols):
        return select(*cols).select_from(Stage).join(Workflow).where(Workflow.user_id==owner,Workflow.portfolio=="india")
    data=Stage.summary_json
    # Recoveries are new vintages and must never replace the original decision in a backtest.
    candidates=(await db.execute(scoped(data["result"]["rows"],data["settings"]["packet_id"].as_integer(),Stage.created_at)
                .where(storage.of_kind("attempt"),data["result"]["scoring_version"].as_integer()==3,
                       data["recovered_from"].as_integer().is_(None))
                .order_by(Stage.id))).all()
    packet_ids={p for _,p,_ in candidates if p}
    packets={}
    if packet_ids:
        packets=dict((await db.execute(scoped(Stage.id,data["research"]["calendars"]).where(Stage.id.in_(packet_ids)))).all())
    dates_by_venue=defaultdict(set)
    prices=defaultdict(dict)
    for schedule in packets.values():
        for venue,sessions in (schedule or {}).items():
            dates_by_venue[venue].update(sessions)
    for rows,packet_id,_ in candidates:
        schedule=packets.get(packet_id) or {}
        for row in rows or []:
            ledger=row["technical_v3"]
            day=ledger.get("session")
            k=row["listing"]
            if ledger["vintage"]!="prospective" or not day or day>as_of.isoformat():
                continue
            src=ledger["sources"]["stock"]
            bar=src.get("last_bar")
            if (bar and bar["as_of"][:10]==day and bar.get("volume") and src.get("instrument")
                and src.get("action_url") and not any(k in ledger["reason"] for k in ("identity changed","price basis unresolved"))):
                prices[k].setdefault(day,(bar["close"],src,sorted(schedule.get(k.partition(":")[0],{}))))
    cohorts=defaultdict(list)
    seen=set()
    for rows,packet_id,created in candidates:
        for row in rows or []:
            ledger=row["technical_v3"]
            day=ledger.get("session")
            if ledger["vintage"]!="prospective" or not day or day>as_of.isoformat() or (day,row["listing"]) in seen:
                continue
            seen.add((day,row["listing"]))
            k=row["listing"]
            venue=k.partition(":")[0]
            ahead=sorted(d for d in dates_by_venue[venue] if d>day)
            gain=None
            fill_multiplier=None
            # No forward-fill. The evaluation packet at exit must know every intervening session.
            if len(ahead)>=20 and ahead[19]<=as_of.isoformat() and day in prices[k] and ahead[19] in prices[k]:
                entry,meta,_=prices[k][day]
                close,endmeta,exit_schedule=prices[k][ahead[19]]
                matched=day in exit_schedule and exit_schedule[exit_schedule.index(day)+1:exit_schedule.index(day)+21]==ahead[:20]
                if matched and meta["instrument"]==endmeta["instrument"]:
                    multiplier=1.
                    fill_multiplier=1.
                    for action in endmeta["actions"]:
                        if day<action["date"]<=ahead[19]:
                            multiplier*=action["multiplier"] or 0
                            if action["date"]>ahead[0]:
                                fill_multiplier*=action["multiplier"] or 0
                    if multiplier:
                        gain=close*multiplier/entry-1
            market=ledger.get("sources",{}).get("benchmark",{})
            scale=ledger["factors"]["Momentum"]["inputs"].get("raw_scale")
            volatility="Unknown" if scale is None else "Below 1%" if scale<.01 else "1–2%" if scale<=.02 else "Above 2%"
            cohorts[day].append({"listing":k,"issuer":ledger["sources"]["stock"].get("instrument"),"turnover":ledger["turnover"],
                "volatility":volatility,"sensitivities":ledger.get("sensitivities",{}),
                "candidate":row["score"],"legacy":row.get("legacy_score"),"momentum":ledger["momentum_baseline"],"outcome":gain,
                "entry_session":ahead[0] if ahead else None,"share_multiplier":fill_multiplier,
                "label_end":ahead[19] if len(ahead)>=20 else None,"coverage":row["coverage"],"direction":ledger["direction"],"venue":venue,"regime":market.get("regime","Unknown"),
                "liquidity":"Review" if ledger["flags"] else "Standard","corporate_actions":bool(ledger["sources"]["stock"].get("actions")),
                "provider":(ledger["sources"]["stock"].get("last_bar") or {}).get("basis","Unknown")})
    if executions is not None:
        return execution_review(cohorts,executions)
    return await asyncio.to_thread(assessment,cohorts,as_of)


async def stage4_validated(db, owner, cutoff):
    from sqlalchemy import func
    first=await db.scalar(select(func.min(Stage.created_at)).join(Workflow).where(
        Workflow.user_id==owner, Workflow.portfolio=="india", storage.of_kind("attempt"),
        Stage.summary_json["result"]["scoring_version"].as_integer()==3))
    decision=date.fromisoformat(cutoff[:10])
    if not first or decision<add_months(first.date(),36)+timedelta(days=40):
        return False
    return (await evaluate(db,owner,decision))["promoted"]
