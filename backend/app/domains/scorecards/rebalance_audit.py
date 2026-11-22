"""Read-only summaries of frozen Rebalance and final outputs, including legacy tables."""
from collections import Counter

from app.domains.runs.final_score_math import ACTION_HEADER, RATIONALE_HEADERS, normalize_action
from .scoring import R_WEIGHTS, number


def missing(value):
    return value is None or str(value).strip().casefold() in ("","-","–","—","n/a","na","unknown")


def audit_job(table):
    gaps=[]
    for row in table["rows"]:
        listing=f"{row.get('Exchange Symbol')}:{row.get('Stock Symbol')}"
        action=normalize_action(row.get(ACTION_HEADER))
        scope=table.get("requested_fields",{}).get(listing)
        for factor,header in RATIONALE_HEADERS.items():
            if scope is not None and factor not in scope:
                continue
            why=header.replace("Score Rationale","Rationale")
            if missing(row.get(header)) or missing(row.get(why)):
                gaps.append([listing,factor,"evidence unavailable"])
            elif number(row[header],-3,3,integer=True) is None:
                gaps.append([listing,factor,"invalid"])
        if not action and (scope is None or "action" in scope):
            gaps.append([listing,"action","invalid"])
        for name in ("Current Units","Units Change","Final Units","Price Per Unit","Entry Range","Stop Loss","Target","Upside Horizon (% return)","Weeks"):
            field={"Units Change":"delta","Entry Range":"entry","Stop Loss":"stop","Target":"target"}.get(name)
            if scope is not None and field not in scope:
                continue
            if missing(row.get(name)):
                if action in ("Buy New","Add more") and name in ("Price Per Unit","Entry Range","Stop Loss","Target"):
                    state="trade input missing"
                elif name in ("Current Units","Units Change","Final Units"):
                    state="trade input missing"
                elif action in ("Hold","Trim","Sell All") and name in ("Entry Range","Stop Loss","Target","Upside Horizon (% return)","Weeks"):
                    state="not applicable"
                else:
                    state="informational"
                gaps.append([listing,name,state])
    counts=Counter(g[2] for g in gaps)
    return {"job_id":table["job_id"],"slot":table.get("slot"),"model":table.get("model"),
            "listings":len(table["rows"]),"counts":dict(counts),"fields":gaps}


def coverage_counts(rows):
    assessed=sum(r.get("score") is not None for r in rows)
    complete=sum(r.get("coverage")=="Complete" and r.get("score") is not None for r in rows)
    return {"assessed":assessed,"complete":complete,"provisional":assessed-complete,"unassessed":len(rows)-assessed}


def replay(result):
    if result.get("card")!="rebalance" or not isinstance(result.get("rows"),list):
        return result
    jobs=[audit_job(t) for t in result.get("model_tables",[]) if isinstance(t.get("rows"),list)]
    return {**result,"rebalance_audit":{"weights":R_WEIGHTS,"coverage":coverage_counts(result["rows"]),
            "jobs":jobs,"actions":dict(Counter(r.get("action") or "Unavailable" for r in result["rows"]))}}


def final_counts(rows):
    complete=sum(r.get("status")=="Complete" for r in rows)
    eligible=sum(r.get("status")=="Complete" and r.get("sizing_reason")=="Subject to broker order checks" for r in rows)
    holds=sum(r.get("status")=="Complete" and r.get("action")=="Hold" for r in rows)
    return {"assessed":len(rows),"complete":complete,"holds":holds,"eligible":eligible,"blocked":len(rows)-holds-eligible}
