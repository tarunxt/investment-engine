"""Recover only the frozen final calculation from the workflow's saved inputs."""
from datetime import datetime, timezone
from fastapi import HTTPException
from sqlalchemy import select
from app.domains.recommendation_audit.models import EvidenceRecord
from app.domains.recommendation_audit.schemas import Formula
import json
from .final_score_math import DIRECTIONAL_SIZING
from .frozen_final import validate_frozen_final


def materialize_rows(calculations):
    rows = []
    for (exchange, symbol), c in calculations.items():
        weighted = []
        for term in c["weighted_rows"]:
            rule = {"min": term.get("min", -3), "max": term.get("max", 3)}
            if term["id"] == "technical-scan-confidence":
                rule["actualValue"] = term["score"]
            if term.get("integer"):
                rule.update(integerOnly=True, actualValue=term["actual"])
            weighted.append({**term, "validationRule": rule})
        rows.append({
            "exchange": exchange, "symbol": symbol, "action": c["action"], "estimate": c["estimate"],
            "score": c["raw_score"], "rawScore": c["raw_score"], "effectiveScore": c["effective_score"],
            "scorePolicy": "score-matrix-raw-effective-v2", "valid_suggestions": c["valid_suggestions"],
            "formula_inputs": {**c["inputs"], "calculatedScore": c["raw_score"],
                              "rows": c["detail_rows"], "detailedRationaleRows": weighted},
        })
    return rows


async def historical_inputs(db, workflow, technical_id):
    records = await db.scalars(select(EvidenceRecord).where(
        EvidenceRecord.user_id == workflow.user_id, EvidenceRecord.run_id == technical_id,
        EvidenceRecord.kind == "input", EvidenceRecord.source_key == f"run:{technical_id}",
    ).limit(2))
    inputs = list(records)
    if len(inputs) != 1:
        return None
    frozen = inputs[0].payload
    if frozen.get("provenance") != "prospective" or not frozen.get("formula"):
        return None
    refs = frozen.get("rebalance_sources") or []
    if not refs or any(ref.get("coverage") != "complete" for ref in refs):
        return None
    ids = [key for ref in refs for key in ref["output_ids"]]
    records = list(await db.scalars(select(EvidenceRecord).where(
        EvidenceRecord.user_id == workflow.user_id, EvidenceRecord.kind == "output",
        (EvidenceRecord.id.in_(ids)) | (EvidenceRecord.run_id == technical_id),
    ).limit(201)))
    if len(records) > 200 or not set(ids).issubset({r.id for r in records}):
        return None
    revisions = {}
    for record in records:
        digest = record.payload.get("response_hash")
        if (record.payload.get("provenance") != "prospective" or not digest
                or revisions.setdefault(str(record.job_id), digest) != digest):
            return None
    formula = Formula.model_validate(frozen["formula"])
    return {"formula": json.loads(json.dumps(formula.model_dump(), default=float)),
            "rebalance_run_ids": frozen["rebalance_run_ids"], "response_hashes": revisions}


async def recover_final(db, workflow, *, corrected=False):
    stages = {stage.stage: stage for stage in workflow.stages}
    final = stages.get("actionables")
    if final is None or final.status not in {"processing", "running", "completed"}:
        raise HTTPException(409, "No started Actionables stage is eligible for reconciliation")
    for name in ("sync", "threats", "swing", "rebalance", "technical"):
        stage = stages.get(name)
        if not stage or stage.status not in {"partial", "completed", "skipped"} or not stage.completed_at:
            raise HTTPException(409, f"Missing terminal {name} stage evidence")
    saved = (final.summary_json or {}).get("frozen_final")
    if corrected:
        existing = (final.summary_json or {}).get("corrected_final_v2")
        if existing and existing.get("sizing_policy") == DIRECTIONAL_SIZING:
            return existing
    elif saved:
        return saved
    technical = stages["technical"]
    receipt = (technical.summary_json or {}).get("final_inputs")
    if corrected and existing:
        # Rebuild this exact replay from its captured formula and source hashes.
        receipt = existing
    if receipt is None and corrected and isinstance(saved, dict) and saved.get("schema") == "workflow-final-v2":
        receipt = saved
    if receipt is None and technical.run_id:
        receipt = await historical_inputs(db, workflow, technical.run_id)
    if not isinstance(receipt, dict) or not technical.run_id:
        raise HTTPException(409, "No saved final calculation or exact Stage 5 formula and source revisions for this run")
    captured = {
        "schema": "workflow-final-v2", "formula_version": "score-matrix-v2" if corrected else receipt.get("formula_version", "score-matrix-v1"),
        "scorePolicy": "score-matrix-raw-effective-v2", "technical_run_id": technical.run_id,
        "broker": workflow.portfolio, "workflow_sequence": workflow.sequence,
        "captured_at": datetime.now(timezone.utc).isoformat(), "rows": [],
        "formula": receipt.get("formula"), "response_hashes": receipt.get("response_hashes"),
        "rebalance_run_ids": receipt.get("rebalance_run_ids"),
    }
    await validate_frozen_final(db, captured, user_id=workflow.user_id, portfolio=workflow.portfolio,
                                sequence=workflow.sequence, rebuild=True)
    return captured
