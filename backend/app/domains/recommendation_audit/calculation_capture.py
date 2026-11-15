"""Explicitly record a present calculation without relabelling it as historical."""
from sqlalchemy import select
from app.domains.runs.models import Run
from app.domains.runs.run_identity import analysis_run_identity
from .capture import add_evidence, build_decisions, freeze_input, freeze_output, owned_jobs, status, TERMINAL
from .deterministic import digest
from .technical import agreed_technical


def capture_calculation(session, user_id, request):
    ids = request.run_ids
    if len(ids) != len(set(ids)) or any(i < 1 for i in ids): raise ValueError("Distinct positive source run IDs required")
    runs = list(session.scalars(select(Run).where(Run.id.in_(ids), Run.user_id == user_id).order_by(Run.created_at, Run.id).with_for_update()))
    if len(runs) != len(ids): raise LookupError("Source run not found")
    identities = [analysis_run_identity(r) for r in runs]
    if len({i.market for i in identities}) != 1 or any(i.stage != "rebalance" or i.market not in {"india","us"} for i in identities): raise ValueError("Owned rebalance sources must share a market")
    jobs = [job for run in runs for job in owned_jobs(session, run)]
    technical = None
    if request.technical_run_id:
        technical = session.scalar(select(Run).where(Run.id == request.technical_run_id, Run.user_id == user_id).with_for_update())
        if not technical: raise LookupError("Technical run not found")
        identity = analysis_run_identity(technical)
        if identity.stage != "technical" or identity.market != identities[0].market: raise ValueError("Technical source must share the rebalance market")
        jobs += owned_jobs(session, technical)
    if not jobs or any(status(j.status) not in TERMINAL for j in jobs): raise ValueError("All calculation source attempts must be terminal")
    if len(jobs) > 200: raise ValueError("Calculation exceeds sample bound")
    expected = {j.id: digest(j.response or "") for j in jobs}
    if expected != request.expected_response_hashes: raise ValueError("Source responses changed or revision set is incomplete")
    outputs, source_inputs = [], []
    for run in runs:
        source_jobs = owned_jobs(session, run)
        inp = freeze_input(session, run, source_jobs, provenance="legacy_observed")
        source_inputs.append(inp)
        outputs += [freeze_output(session, run, j, inp) for j in source_jobs]
    technical_map = None
    if technical:
        tech_jobs = owned_jobs(session, technical)
        tech_inp = freeze_input(session, technical, tech_jobs, provenance="legacy_observed")
        frozen = [freeze_output(session, technical, j, tech_inp) for j in tech_jobs]
        technical_map = agreed_technical(frozen, tech_inp.content)
    request_payload = request.model_dump(mode="json")
    # New immutable calculation context preserves every source input hash.
    inp = add_evidence(session, user_id=user_id, kind="calculation_input", source_key=f"calculation:{digest(request_payload)}", run_id=runs[-1].id,
        payload={**source_inputs[-1].payload, "provenance":"calculation_observed", "technical_required":technical is not None, "formula":request_payload["formula"], "jobs":[{"id": j.id} for j in jobs if j.id in {o.job_id for o in outputs}], "source_inputs":[i.id for i in source_inputs], "source_input_hashes":[i.content_hash for i in source_inputs], "request":request_payload})
    # Its observation time is not the original decision time or policy.
    return build_decisions(session, runs[-1], inp, outputs, formula=request.formula, technical_map=technical_map, revision="calculation_observed", completion_at=None)
