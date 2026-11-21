from statistics import mean
from math import isclose
from .prompts import CARDS, CATEGORIES
from .scoring import ACTION_SCORES, R_WEIGHTS, T_WEIGHTS, favorable, weighted, number

DEFAULT_WEIGHTS = dict(zip(CARDS, [98*17/22,98*5/22,1,1]))
FACTORS = {"rebalance": set(R_WEIGHTS), "technical":set(T_WEIGHTS), "threats":set(CATEGORIES), "pairwise":{"pairwise"}}


def policy(weights, factors, actions=None):
    if set(weights)!=set(CARDS) or any(number(v,0,100) is None for v in weights.values()) or not isclose(sum(weights.values()),100,abs_tol=0.0001):
        raise ValueError("Enter four nonnegative weights totalling 100%")
    for card, group in factors.items():
        if card not in FACTORS or not group or not set(group)<=FACTORS[card] or not any(group.values()) or any(number(v,0,1e6) is None for v in group.values()):
            raise ValueError("Invalid subsection weights")
    actions = ACTION_SCORES if actions is None else actions
    if set(actions)!=set(ACTION_SCORES) or any(number(v,-3,3) is None for v in actions.values()):
        raise ValueError("Invalid consensus action mapping")
    return {"weights":weights,"factors":factors,"actions":actions}


def calculate_final(manifest, attempts, config):
    tables={card:{r["listing"]:r for r in output["rows"]} for card,output in attempts.items()}
    rows=[]
    for stock in manifest["stocks"]:
        key=stock["listing"]
        scores,contributions,coverage={}, {}, {}
        for card in CARDS:
            data=tables.get(card,{}).get(key,{})
            score=data.get("score")
            status=data.get("coverage","Unassessed")
            terms=dict(data.get("terms",{}))
            factors=config["factors"].get(card)
            if card=="rebalance" and data.get("action"):
                terms["action"]=favorable(config["actions"][data["action"]])
                factors=factors or R_WEIGHTS
            if factors:
                score,divisor=weighted(terms,factors)
                if divisor < sum(factors.values()):
                    status="Partial"
            scores[card]=score
            coverage[card]=status
            contributions[card]=None if score is None else score*config["weights"][card]/100
        final,available=weighted(scores,config["weights"])
        complete=all(not config["weights"][c] or scores[c] is not None and coverage[c]=="Complete" for c in CARDS)
        signed=6*final/100-3 if final is not None else None
        position=stock["settled"]
        action=None if signed is None or position is None else ("Add more" if stock["units"] else "Buy New") if signed>=1 else "Hold" if signed>=-1 else "Trim" if signed>=-2 else "Sell All"
        rebal=tables.get("rebalance",{}).get(key,{})
        buys=[n for r in rebal.get("raw_rows",[]) if (n:=number(r.get("Units Change"),0,1e15)) is not None and n>0]
        units=position if action=="Sell All" else position/2 if action=="Trim" else mean(buys) if action in ("Add more","Buy New") and buys else 0 if action=="Hold" else None
        rows.append({**stock,"scores":scores,"contributions":contributions,"coverage":coverage,"available_weight":available,
                     "final":final,"signed":signed,"action":action,"suggested_units":units,"status":"Complete" if complete else "Provisional" if final is not None else "Unassessed"})
    rows.sort(key=lambda r:(r["status"]!="Complete", r["final"] is None, -(r["final"] or 0), r["listing"]))
    ranks={}
    for row in rows:
        status=row["status"]
        ranks[status]=ranks.get(status,0)+1
        row["rank"]=ranks[status] if row["final"] is not None else None
    return rows

