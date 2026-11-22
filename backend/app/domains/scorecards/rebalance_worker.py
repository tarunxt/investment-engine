"""Execute one selected slot, checkpoint accepted fields, and bound repair to one call."""
import json
from dataclasses import replace
from app.domains.api_usage.recorder import provider_usage_phase
from . import rebalance_output as contract


def execute(provider, model, prompt, batch, save, previous=None):
    envelope=json.loads(prompt.split("\n")[-1])
    listings=envelope["listings"]
    if set(listings)!=set(batch["listings"]):
        raise ValueError("Rebalance packet differs from the frozen assignment")
    revision=batch["rebalance_v2"]
    saved=previous or {}
    rows=dict(saved.get("rows",{}))
    receipts=list(saved.get("calls",[]))
    first_rows=dict(saved.get("first_rows",{}))
    scope=batch.get("repair_fields") or {}
    keys=list(listings)
    limit=max(1,contract.COMPLETION_BUDGET//contract.TOKENS_PER_LISTING)

    def snapshot():
        missing=contract.issues(rows,{k:listings[k] for k in rows})
        if scope:
            missing={k:[f for f in scope[k] if rows[k].get(f) is None] for k in rows}
            missing={k:v for k,v in missing.items() if v}
        return {"version":2,"rows":rows,"first_rows":first_rows,"calls":receipts,
                "missing":missing}

    def call(page, repair=None):
        packet={**envelope,"listings":{k:listings[k] for k in page}}
        with provider_usage_phase("row_repair" if repair else "initial_generation"):
            response=provider.generate(model=model,prompt=contract.instructions(revision,packet,repair))
        accepted=contract.validated(response.content,packet["listings"])
        if repair and scope:
            for k,fields in repair.items():
                rows[k]={f:v if f in fields else None for f,v in accepted[k].items()}
                first_rows[k]=dict(rows[k])
        elif repair:
            contract.merge(rows,accepted,repair)
        else:
            rows.update(accepted)
            first_rows.update({k:dict(v) for k,v in accepted.items()})
        receipts.append({"phase":"repair" if repair else "initial","listings":page,"requested":repair,
                         "hash":contract.digest_text(response.content or ""),"model":response.model,
                         "tokens_in":response.tokens_in,"tokens_out":response.tokens_out,"cost":response.cost})
        save(snapshot())
        return response

    result=None
    for i in range(0,len(keys),limit):
        page=[k for k in keys[i:i+limit] if k not in rows]
        if page:
            result=call(page,{k:scope[k] for k in page} if scope else None)
    pending=contract.repairable(rows,listings)
    if not scope and pending and not any(r["phase"]=="repair" for r in receipts):
        requested={k:pending[k] for k in list(pending)[:limit]}
        result=call(list(requested),requested)
    if result is None:
        from app.domains.ai_providers.base import AIProviderResponse
        result=AIProviderResponse("",0,0,0,"",model)
    return replace(result,content=contract.render(rows,listings,model),
                   tokens_in=sum(r["tokens_in"] for r in receipts),tokens_out=sum(r["tokens_out"] for r in receipts),
                   cost=round(sum(r["cost"] for r in receipts),6)),snapshot()
