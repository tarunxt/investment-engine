"""Fill gaps in one frozen output using a new, independently addressable child output."""
from .rebalance_output import FACTORS, R_WEIGHTS, favorable, weighted


def gaps(result):
    missing={}
    for row in result["rows"]:
        terms=row.get("signed_terms",{})
        fields=[f for f in FACTORS if terms.get(f) is None]
        if terms.get("action") is None:
            fields.extend(["action", "cruxx", "delta", "entry", "stop", "target"])
        invalid=set(f for slot in row.get("trade_gaps",{}).values() for f in slot)
        if row.get("action") in ("Buy New","Add more") and invalid.intersection({"delta","price","entry","stop","target"}):
            fields.extend(["action","cruxx","delta","entry","stop","target"])
        if row.get("action") in ("Trim","Sell All") and invalid:
            fields.extend(["action","delta","cruxx"])
        if fields:
            missing[row["listing"]]=list(dict.fromkeys(fields))
    return missing


def with_evidence(requests,packets):
    eligible={}
    for k,fields in requests.items():
        p=packets.get(k,{})
        allowed=p.get("allowed",{})
        actionable=[f for f in fields if allowed.get(f) or f=="action" and allowed.get("cruxx") or
                    f in ("delta","entry","stop","target") and p.get("price") and p.get("units") is not None]
        if actionable:
            eligible[k]=actionable
    return eligible


def combine(parent, child, requested):
    rows=[]
    repairs={r["listing"]:r for r in child["rows"]}
    for original in parent["rows"]:
        key=original["listing"]
        fields=requested.get(key,[])
        if not fields:
            rows.append(original)
            continue
        repair=repairs[key]
        terms=dict(original.get("signed_terms",{}))
        action=original.get("action")
        for f in fields:
            if terms.get(f) is None and repair.get("signed_terms",{}).get(f) is not None:
                terms[f]=repair["signed_terms"][f]
                if f=="action":
                    action=repair["action"]
        signed,weight=weighted(terms,R_WEIGHTS)
        row={**original,"score":favorable(signed),"available_weight":weight,"action":action,"signed_terms":terms,
             "terms":{k:favorable(terms.get(k)) for k in R_WEIGHTS},
             "coverage":"Complete" if weight==sum(R_WEIGHTS.values()) else "Partial" if weight else "Unassessed"}
        if "delta" in fields and action:
            from app.domains.runs.final_score_math import ACTION_HEADER, normalize_action
            accepted=[r for r in repair["raw_rows"] if normalize_action(r.get(ACTION_HEADER))==action and type(r.get("Units Change")) is int]
            if accepted:
                row["sizing_rows"]=accepted
                row["trade_gaps"]={}
                if original.get("action") is None:
                    row["raw_rows"]=accepted
                    row["model_count"]=repair.get("model_count",0)
            elif original.get("action") is None:
                row["trade_gaps"]=repair.get("trade_gaps") or {"repair":["Action plan unavailable"]}
        if any(row.get("trade_gaps",{}).values()) and row["coverage"]=="Complete":
            row["coverage"]="Partial"
        rows.append(row)
    return {**child,"rows":rows,"repaired_from":parent["id"],"requested_fields":requested,
            "model_tables":[*parent.get("model_tables",[]),*({**t,"requested_fields":requested} for t in child["model_tables"])]}
