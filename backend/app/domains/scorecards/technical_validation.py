"""Paired forward evaluation on frozen Stage 2 dates. A missing label is never a loss or a win."""
import asyncio
import calendar
import random
from collections import defaultdict
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


def report(cohorts):
    expected=scored=legacy_scored=labeled=0
    daily=[]
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
                for key in ("coverage","venue","regime","liquidity","corporate_actions","provider"):
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
            "bands":{k:{"n":len(g),"up_rate":mean(v>0 for v in g),"median_return":median(g)} for k,g in by_band.items()},
            "slices":[{"by":k,"value":v,"n":len(g),"up_rate":mean(x>0 for x in g),"median_return":median(g)} for (k,v),g in slices.items()]}


def add_months(day, months):
    m=day.month-1+months
    y=day.year+m//12
    return date(y,m%12+1,min(day.day,calendar.monthrange(y,m%12+1)[1]))


def assessment(cohorts, as_of):
    # Fix the time blocks before outcomes mature. A rolling last-six-month "test" peeks on every run.
    first=date.fromisoformat(min(cohorts)) if cohorts else as_of
    validation_start=add_months(first,24)
    holdout=add_months(first,30)
    end=add_months(first,36)
    def block(start,stop):
        return {d:[r if r.get("label_end") and r["label_end"]<stop.isoformat() else {**r,"outcome":None}
                   for r in rows] for d,rows in cohorts.items() if start.isoformat()<=d<stop.isoformat()}
    val=report(block(validation_start,holdout))
    # Reveal the reserved test only after its last twenty-session label can mature.
    mature=as_of>=end+timedelta(days=40)
    test=report(block(holdout,end)) if mature else report({})
    bounds=test["paired_lift_95"]
    acc=test["balanced_accuracy"]
    passed=(mature and test["qualifying_dates"]>=30 and test["scored"]>=test["legacy_scored"]
            and all(v and v[0]>0 for d in bounds.values() for v in d.values())
            and acc["legacy"] is not None and acc["candidate"] is not None and acc["candidate"]>=acc["legacy"])
    return {"version":3,"status":"Validated" if passed else "Unproven","promoted":bool(passed),
            "validation_start":str(validation_start),"holdout_start":str(holdout),"holdout_end_exclusive":str(end),
            "monitoring":report({d:rows for d,rows in cohorts.items() if d<holdout.isoformat()}),
            "validation":val,"holdout":test,"holdout_open":mature}


async def evaluate(db, owner, as_of):
    def scoped(*cols):
        return select(*cols).select_from(Stage).join(Workflow).where(Workflow.user_id==owner,Workflow.portfolio=="india")
    data=Stage.summary_json
    # Recoveries are new vintages and must never replace the original decision in a backtest.
    candidates=(await db.execute(scoped(data["result"]["rows"],data["settings"]["packet_id"].as_integer(),Stage.created_at)
                .where(storage.of_kind("attempt"),data["result"]["scoring_version"].as_integer()==3)
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
                prices[k].setdefault(day,(bar["close"],src,list(schedule.get(k.partition(":")[0],{}))))
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
            # No forward-fill. The evaluation packet at exit must know every intervening session.
            if len(ahead)>=20 and ahead[19]<=as_of.isoformat() and day in prices[k] and ahead[19] in prices[k]:
                entry,meta,_=prices[k][day]
                close,endmeta,exit_schedule=prices[k][ahead[19]]
                matched=day in exit_schedule and exit_schedule[exit_schedule.index(day)+1:exit_schedule.index(day)+21]==ahead[:20]
                if matched and meta["instrument"]==endmeta["instrument"]:
                    multiplier=1.
                    for action in endmeta["actions"]:
                        if day<action["date"]<=ahead[19]:
                            multiplier*=action["multiplier"] or 0
                    if multiplier:
                        gain=close*multiplier/entry-1
            market=ledger.get("sources",{}).get("benchmark",{})
            cohorts[day].append({"listing":k,"issuer":ledger["sources"]["stock"].get("instrument"),"turnover":ledger["turnover"],
                "candidate":row["score"],"legacy":row.get("legacy_score"),"momentum":ledger["momentum_baseline"],"outcome":gain,
                "label_end":ahead[19] if len(ahead)>=20 else None,"coverage":row["coverage"],"direction":ledger["direction"],"venue":venue,"regime":market.get("regime","Unknown"),
                "liquidity":"Review" if ledger["flags"] else "Standard","corporate_actions":bool(ledger["sources"]["stock"].get("actions")),
                "provider":(ledger["sources"]["stock"].get("last_bar") or {}).get("basis","Unknown")})
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
