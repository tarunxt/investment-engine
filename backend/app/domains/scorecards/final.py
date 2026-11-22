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
            if card=="technical" and data.get("technical_v3"):
                # The frozen promotion decision belongs to this output, including on replays.
                if attempts[card].get("stage4_method")=="v3":
                    factors=None
                else:
                    score=data.get("legacy_score")
                    status="Complete" if score is not None else "Unassessed"
                    terms={"candles":score}
            if factors:
                score,divisor=weighted(terms,factors)
                if divisor < sum(factors.values()):
                    status="Partial"
            if card=="pairwise" and (attempts.get(card,{}).get("pair_counts") or {}).get("mode")=="balanced":
                status="Balanced trial"
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
        tech=tables.get("technical",{}).get(key,{})
        using_candidate=attempts.get("technical",{}).get("stage4_method")=="v3" and config["weights"]["technical"]>0
        constrained=using_candidate and (tech.get("coverage")!="Complete" or bool(tech.get("technical_v3",{}).get("flags")))
        if constrained:
            action=units=None
        eligibility = ("Technical evidence incomplete or execution constrained" if constrained else "Incomplete positive-weight scores" if not complete else "Position unavailable" if position is None
                       else "No position to sell" if action in ("Trim","Sell All") and position == 0
                       else "Hold" if action == "Hold" else "Suggested quantity unavailable" if units is None or units<=0
                       else "Subject to broker order checks")
        rows.append({**stock,"scores":scores,"contributions":contributions,"coverage":coverage,"available_weight":available,
                     **({"technical_method":attempts["technical"].get("stage4_method","legacy"),"technical_range":tech["technical_v3"]["range"]} if tech.get("technical_v3") else {}),
                     "final":final,"signed":signed,"action":action,"suggested_units":units,"sizing_reason":eligibility,"status":"Complete" if complete else "Provisional" if final is not None else "Unassessed"})
    rows.sort(key=lambda r:(r["status"]!="Complete", r["final"] is None, -(r["final"] or 0), r["listing"]))
    ranks={}
    for row in rows:
        status=row["status"]
        ranks[status]=ranks.get(status,0)+1
        row["rank"]=ranks[status] if row["final"] is not None else None
    return rows



def compare_formula(rows, outputs, previous):
    """Evaluate the previous base divisor and signed multipliers on the same slot means."""
    from app.domains.runs.final_score_math import weighted_score, normalize_action, ACTION_HEADER, ACTION_VALUES
    from app.domains.runs.supplemental_scores import blend_actionable_score
    groups = {card: {row["listing"]:row for row in attempt["rows"]} for card,attempt in outputs.items()}
    comparisons = []
    for row in rows:
        key = row["listing"]
        reb = groups.get("rebalance",{}).get(key,{})
        tech = groups.get("technical",{}).get(key,{})
        terms = dict(reb.get("signed_terms",{}))
        terms["mean-mode-action"] = previous.actionScores.get(reb.get("action"))
        terms["last-5-candles-trend"] = tech.get("signed_terms",{}).get("candles")
        terms["premarket-trend"] = tech.get("signed_terms",{}).get("premarket")
        terms.pop("action",None)
        factors = [{"id":name,"score":float(terms[name]) if terms.get(name) is not None else None,
                    "multiplier":float(weight)} for name,weight in previous.detailedRationaleMultipliers.items()
                   if name != "technical-scan-confidence" and (tech or name not in ("last-5-candles-trend","premarket-trend"))]
        signed, divisor = weighted_score(factors,float(previous.detailedRationaleDenominator) if previous.detailedRationaleDenominator else None)
        if signed is None:
            votes = [ACTION_VALUES[a] for r in reb.get("raw_rows",[]) if (a:=normalize_action(r.get(ACTION_HEADER))) in ACTION_VALUES]
            signed = mean(votes) if votes else None
        original = blend_actionable_score(max(-3,min(3,signed)),groups.get("pairwise",{}).get(key,{}).get("score"),
                                          groups.get("threats",{}).get(key,{}).get("score")) if signed is not None else None
        comparisons.append({"Listing":key,"Previous formula /100":favorable(original),"Previous divisor":divisor,
                            "Selected weights /100":row["final"],"Coverage":row["status"]})
    return comparisons
