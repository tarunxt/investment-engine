"""Replay an eight-opponent schedule against frozen full outputs and their final policies."""
from sqlalchemy import select
from . import storage
from .final import calculate_final
from .pair_plan import pair_schedule
from app.domains.runs.models import AutoRebalanceWorkflow as Workflow


def compare(manifest, outputs, policy, top=5):
    pair=outputs["pairwise"]
    rows=pair["rows"]
    keys=[r["listing"] for r in rows]
    if len(keys)<=9 or any(r["valid"]!=len(keys)-1 for r in rows):
        return None
    chosen=set(pair_schedule(keys,"balanced"))
    sample=[]
    for r in rows:
        key=r["listing"]
        results=[v["verdict"] for v in r["comparisons"] if tuple(sorted((key,v["opponent"]))) in chosen]
        if len(results)!=8 or "UNKNOWN" in results:
            return None
        score=100*(results.count(key)+results.count("TIE")/2)/8
        sample.append({**r,"score":score,"terms":{"pairwise":score}})
    full=calculate_final(manifest,outputs,policy)
    alternative=calculate_final(manifest,{**outputs,"pairwise":{"rows":sample}},policy)
    def top_set(values,field):
        ordered=sorted((r for r in values if r.get(field) is not None),key=lambda r:(-r[field],r["listing"]))
        return {r["listing"] for r in ordered[:top]}
    full_top=top_set(full,"final")
    other_top=top_set(alternative,"final")
    actions={r["listing"]:r["action"] for r in alternative}
    return {"full_pairs":len(keys)*(len(keys)-1)//2,"balanced_pairs":len(chosen),
            "pairwise_top5_overlap":len(top_set(rows,"score")&top_set(sample,"score")),
            "final_top5_overlap":len(full_top&other_top),"left_final_top5":sorted(full_top-other_top),
            "entered_final_top5":sorted(other_top-full_top),
            "action_changes":[r["listing"] for r in full if r["action"]!=actions[r["listing"]]]}


async def saved_trials(db,owner):
    data=storage.Stage.summary_json
    finals=(await db.execute(select(storage.Stage.id,data["revision_id"].as_integer(),data["result"]["attempts"],data["result"]["policy"])
            .join(Workflow).where(Workflow.user_id==owner,Workflow.portfolio=="india",storage.of_kind("final"))
            .order_by(storage.Stage.id.desc()).limit(100))).all()
    tested=set()
    result=[]
    for final_id,revision_id,refs,policy in finals:
        pair_id=(refs or {}).get("pairwise")
        if not pair_id or revision_id in tested:
            continue
        pair=await storage.lookup(db,owner,"india","attempt",pair_id)
        if not pair or not pair.result_json or not all(r["coverage"]=="Complete" for r in pair.result_json["rows"]):
            continue
        revision=await storage.lookup(db,owner,"india","revision",revision_id)
        outputs={"pairwise":pair.result_json}
        for card,ref in refs.items():
            if card!="pairwise":
                source=await storage.lookup(db,owner,"india","attempt",ref)
                if source:
                    outputs[card]=source.result_json
        replay=compare(revision.manifest,outputs,policy)
        if replay:
            tested.add(revision_id)
            stats=storage.Stage.summary_json["result"]
            balanced=await db.scalar(select(storage.Stage).join(Workflow).where(Workflow.user_id==owner,Workflow.portfolio=="india",
                storage.of_kind("attempt",revision_id), stats["pair_counts"]["mode"].as_string()=="balanced",
                storage.Stage.status=="completed",
                storage.Stage.summary_json["settings"]["packet_id"].as_integer()==pair.data["settings"].get("packet_id"),
                storage.Stage.summary_json["settings"]["targets"][0]["model"].as_string()==pair.data["settings"]["targets"][0]["model"],
                storage.Stage.summary_json["settings"]["targets"][0]["provider"].as_string()==pair.data["settings"]["targets"][0]["provider"]
                ).order_by(storage.Stage.id.desc()).limit(1)) if pair.data["settings"].get("packet_id") else None
            other=balanced.summary_json["result"] if balanced else {}
            result.append({"final":final_id,"pairwise_output":pair_id,**replay,
                "full_attempt_inr":pair.result_json.get("attempt_cost_inr"),"full_attempt_seconds":pair.result_json.get("attempt_elapsed_seconds"),
                "balanced_measured_output":balanced.id if balanced else None,"balanced_attempt_inr":other.get("attempt_cost_inr"),
                "balanced_attempt_seconds":other.get("attempt_elapsed_seconds")})
    return result
