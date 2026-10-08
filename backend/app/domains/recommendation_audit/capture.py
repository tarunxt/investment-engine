"""Freeze authorized run inputs and stored terminal outputs, never historical claims."""
from __future__ import annotations

from dataclasses import asdict
from datetime import datetime, timezone
import json
from sqlalchemy import select

from app.domains.jobs.models import Job
from app.domains.jobs.output_contracts import normalize_output
from app.domains.jobs.output_runtime import holdings_from_prompt
from app.domains.runs.models import Run, RunJob
from app.domains.runs.run_identity import analysis_run_identity
from .deterministic import calculate, digest, sizing_layer
from .models import DecisionRecord, EvidenceRecord, utcnow
from .schemas import Formula, SCHEMA_VERSION

MAX_CONTENT_BYTES = 1_048_576
TERMINAL = {"completed", "partial", "failed", "cancelled"}


def iso(value):
    if value is None: return None
    return value.replace(tzinfo=timezone.utc).isoformat() if value.tzinfo is None else value.isoformat()


def status(value):
    return getattr(value, "value", str(value))


def add_evidence(session, *, user_id, kind, source_key, run_id, payload, content=None, job_id=None):
    checksum = digest({"payload": payload, "content": content})
    existing = session.scalar(select(EvidenceRecord).where(EvidenceRecord.user_id == user_id, EvidenceRecord.kind == kind, EvidenceRecord.source_key == source_key, EvidenceRecord.content_hash == checksum))
    if existing: return existing
    record = EvidenceRecord(user_id=user_id, kind=kind, source_key=source_key, run_id=run_id, job_id=job_id, content_hash=checksum, payload=payload, content=content)
    session.add(record)
    session.flush()
    return record


def freeze_input(session, run, jobs, context=None, *, provenance="prospective"):
    identity = analysis_run_identity(run)
    if identity.stage not in {"rebalance", "technical"} or identity.market not in {"india", "us"}: return None
    # Immutable run input is unique by source key. Never replace it with later UI settings.
    existing = session.scalar(select(EvidenceRecord).where(EvidenceRecord.user_id == run.user_id, EvidenceRecord.kind == "input", EvidenceRecord.source_key == f"run:{run.id}"))
    if existing: return existing
    ctx = context.model_dump(mode="json") if hasattr(context, "model_dump") else context or {}
    references, frozen_sources = [], []
    for source_id in ctx.get("rebalance_run_ids", []):
        source = session.scalar(select(Run).where(Run.id == source_id, Run.user_id == run.user_id))
        if source is None or analysis_run_identity(source).market != identity.market or analysis_run_identity(source).stage != "rebalance":
            raise ValueError("Technical source must be an owned rebalance run in the same market")
        references.append(source_id)
        source_input = session.scalar(select(EvidenceRecord).where(EvidenceRecord.user_id == run.user_id, EvidenceRecord.kind == "input", EvidenceRecord.run_id == source_id))
        source_outputs = list(session.scalars(select(EvidenceRecord).where(EvidenceRecord.user_id == run.user_id, EvidenceRecord.kind == "output", EvidenceRecord.run_id == source_id).order_by(EvidenceRecord.captured_at.desc()).limit(201)))
        latest = {}
        for output in source_outputs: latest.setdefault(output.job_id, output)
        source_jobs = owned_jobs(session, source)
        expected = ctx.get("expected_response_hashes", {})
        if provenance == "prospective" and (not source_jobs or any(expected.get(str(j.id), expected.get(j.id)) != digest(j.response or "") for j in source_jobs) or any(j.id not in latest or latest[j.id].payload.get("response_hash") != digest(j.response or "") for j in source_jobs)):
            raise ValueError("Technical input source revisions are missing or changed; refresh source runs")
        frozen_sources.append({"run_id":source_id, "input_id":source_input.id if source_input else None, "output_ids":[o.id for o in latest.values()], "output_hashes":[o.content_hash for o in latest.values()], "coverage":"complete" if source_input and len(latest) == len(source_input.payload["jobs"]) else "unavailable_or_partial"})
    prompt = run.prompt or ""
    bounded = len(prompt.encode()) <= MAX_CONTENT_BYTES
    holdings = holdings_from_prompt(prompt) if bounded and identity.stage == "rebalance" else None
    source_contexts, context_hashes, source_bytes, source_incomplete = {}, {}, 0, False
    for job in jobs:
        context_hash = digest(job.request_context_json)
        context_hashes[job.id] = context_hash
        if context_hash not in source_contexts:
            size = len(json.dumps(job.request_context_json).encode())
            if source_bytes + size <= MAX_CONTENT_BYTES:
                source_contexts[context_hash] = job.request_context_json
                source_bytes += size
            else: source_incomplete = True
    payload = {"schema_version": SCHEMA_VERSION, "provenance": provenance, "market": identity.market, "stage": identity.stage,
        "prompt_hash": digest(prompt), "prompt_id": run.prompt_id, "prompt_version": None,
        "created_at": iso(run.created_at), "available_at": iso(utcnow()) if provenance == "prospective" else None,
        "holdings": list(holdings) if holdings is not None else None,
        "formula": ctx.get("formula"), "objective": ctx.get("objective"), "horizon": ctx.get("horizon"), "rebalance_run_ids": references, "rebalance_sources": frozen_sources,
        "source_contexts": source_contexts, "source_context_coverage": "size_exceeded" if source_incomplete else "complete",
        "jobs": [{"id": j.id, "provider": j.provider, "model": j.model, "request_context_hash": context_hashes[j.id]} for j in jobs],
        "coverage": "complete_prompt" if bounded else "prompt_size_exceeded"}
    return add_evidence(session, user_id=run.user_id, kind="input", source_key=f"run:{run.id}", run_id=run.id, payload=payload, content=prompt if bounded else None)


def freeze_output(session, run, job, input_record):
    text = job.response or ""
    fingerprint = digest({"status": status(job.status), "response_hash": digest(text), "error": job.error_message, "runtime_metadata": job.runtime_metadata_json, "tokens_in": job.tokens_in, "tokens_out": job.tokens_out, "cost_usd": job.estimated_cost, "web_sources": job.web_sources})
    existing = list(session.scalars(select(EvidenceRecord).where(EvidenceRecord.user_id == run.user_id, EvidenceRecord.kind == "output", EvidenceRecord.job_id == job.id).order_by(EvidenceRecord.captured_at.desc()).limit(200)))
    same = next((r for r in existing if r.payload.get("revision_hash") == fingerprint), None)
    if same: return same
    bounded = len(text.encode()) <= MAX_CONTENT_BYTES
    identity = analysis_run_identity(run)
    normalized = normalize_output(text, "rebalance", holdings=input_record.payload.get("holdings")) if bounded and text and identity.stage == "rebalance" else None
    payload = {"schema_version": SCHEMA_VERSION, "revision_hash": fingerprint, "status": status(job.status), "provider": job.provider, "model": job.model,
        "response_hash": digest(text), "response_representation": "stored_job_response", "original_provider_bytes_available": False,
        "error": job.error_message, "created_at": iso(job.created_at), "observed_updated_at": iso(job.updated_at),
        "provenance": input_record.payload["provenance"], "available_at": iso(utcnow()) if input_record.payload["provenance"] == "prospective" else None,
        "runtime_metadata": job.runtime_metadata_json, "tokens_in": job.tokens_in, "tokens_out": job.tokens_out, "cost_usd": job.estimated_cost,
        "web_sources": job.web_sources or [], "rows": [{"row": dict(r.values), "source_values": dict(r.source_values), "source": asdict(r.source), "valid": r.valid and normalized.safe_to_replace} for r in normalized.rows] if normalized else [],
        "coverage": asdict(normalized.coverage) if normalized else None, "findings": [asdict(f) for f in normalized.findings] if normalized else [],
        "size_exceeded": not bounded}
    return add_evidence(session, user_id=run.user_id, kind="output", source_key=f"job:{job.id}", run_id=run.id, job_id=job.id, payload=payload, content=text if bounded else None)


def owned_jobs(session, run):
    jobs = list(session.scalars(select(Job).join(RunJob, RunJob.job_id == Job.id).where(RunJob.run_id == run.id, Job.user_id == run.user_id).order_by(Job.id).limit(201)))
    if len(jobs) > 200: raise ValueError("Run exceeds audit job bound")
    return jobs


def build_decisions(session, run, input_record, outputs, *, formula=None, technical_map=None, revision="terminal", completion_at=None):
    if analysis_run_identity(run).stage != "rebalance": return []
    payload = input_record.payload
    completion_at = completion_at or max((o.payload.get("available_at") or "" for o in outputs), default="") or None
    formula = formula or (Formula.model_validate(payload["formula"]) if payload.get("formula") else None)
    grouped = {}
    for output in outputs:
        for row in output.payload.get("rows", []):
            values = row["row"]
            key = (str(values.get("stock_symbol", "")).upper(), str(values.get("exchange_symbol", "")).upper())
            if not key[0]: continue
            grouped.setdefault(key, []).append({**row, "job_id": output.job_id, "provider": output.payload["provider"], "model": output.payload["model"]})
    results = []
    for (symbol, exchange), samples in grouped.items():
        technical = (technical_map or {}).get((symbol, exchange))
        calc = calculate(samples, formula, technical)
        if (revision.startswith("technical:") or payload.get("technical_required")) and technical is None:
            calc["findings"].append({"code":"technical_coverage_incomplete", "severity":"error", "detail":"Technical attempts failed, omitted this stock, or disagree; no final action is certified."})
            calc["formula_action"] = calc["formula_units"] = None
        successful_jobs = {o.job_id for o in outputs if o.payload["status"] == "completed"}
        represented_jobs = {s["job_id"] for s in samples}
        if represented_jobs != successful_jobs or len(samples) != len(represented_jobs) or len(outputs) != len(payload["jobs"]) or len(successful_jobs) != len(payload["jobs"]):
            calc["findings"].append({"code":"stock_coverage_incomplete", "severity":"error", "detail":"Missing/duplicate stock rows or terminal attempts; no action is certified."})
            calc["formula_action"] = calc["formula_units"] = None
        if revision == "calculation_observed": completion_at = None
        data = {"schema_version": SCHEMA_VERSION, "run_id": run.id, "market": payload["market"], "symbol": symbol, "exchange": exchange, "isin": None,
            "provenance": payload["provenance"] if revision == "terminal" else revision, "decision_at": completion_at or iso(run.created_at), "original_completion_at": completion_at,
            "objective": payload.get("objective"), "horizon": payload.get("horizon"), "formula": formula.model_dump(mode="json") if formula else None,
            "prompt_hash": payload.get("prompt_hash"), "holdings_snapshot": payload.get("holdings"),
            "formula_hash": digest(formula.model_dump(mode="json")) if formula else None, "input_id": input_record.id,
            "source_hashes": [o.content_hash for o in outputs], "output_ids": [o.id for o in outputs], "technical": technical,
            "provider_families": calc["provider_families"], "calculation": calc, "sizing": sizing_layer(calc, payload["market"]),
            "samples": samples, "coverage": {"successful": sum(o.payload["status"] == "completed" for o in outputs), "attempted": len(payload["jobs"]), "captured_terminal": len(outputs)}}
        checksum = digest(data)
        record = session.scalar(select(DecisionRecord).where(DecisionRecord.user_id == run.user_id, DecisionRecord.content_hash == checksum))
        if not record:
            record = DecisionRecord(user_id=run.user_id, run_id=run.id, market=payload["market"], symbol=symbol, exchange=exchange, decision_at=datetime.fromisoformat(completion_at) if completion_at else run.created_at or utcnow(), provenance=data["provenance"], content_hash=checksum, payload=data)
            session.add(record)
            session.flush()
        results.append(record)
    return results


def materialize_run(session, run, *, context=None, provenance="legacy_observed"):
    jobs = owned_jobs(session, run)
    if not jobs or any(status(j.status) not in TERMINAL for j in jobs): raise ValueError("Audit requires a terminal run; pending samples are not Hold")
    inp = freeze_input(session, run, jobs, context, provenance=provenance)
    if inp is None: raise ValueError("Only identifiable equity rebalance/technical runs are supported")
    outputs = [freeze_output(session, run, j, inp) for j in jobs]
    return build_decisions(session, run, inp, outputs)


def capture_terminal(session, job):
    if status(job.status) not in TERMINAL: return
    # Serialize terminal capture with the run lock before querying siblings.
    run = session.scalar(select(Run).join(RunJob, RunJob.run_id == Run.id).where(RunJob.job_id == job.id, Run.user_id == job.user_id).with_for_update())
    if not run: return
    inp = session.scalar(select(EvidenceRecord).where(EvidenceRecord.user_id == run.user_id, EvidenceRecord.kind == "input", EvidenceRecord.run_id == run.id))
    if not inp: return  # No implicit legacy backfill in worker execution.
    freeze_output(session, run, job, inp)
    siblings = owned_jobs(session, run)
    if all(status(j.status) in TERMINAL for j in siblings):
        outputs = [freeze_output(session, run, j, inp) for j in siblings]
        build_decisions(session, run, inp, outputs)
        if analysis_run_identity(run).stage == "technical":
            from .technical import agreed_technical
            # Multiple disagreeing technical samples remain unavailable, rather than selecting one.
            complete = len(outputs) == len(inp.payload["jobs"]) and all(o.payload["status"] == "completed" for o in outputs)
            agreed = agreed_technical(outputs, inp.content) if complete else {}
            for frozen in inp.payload.get("rebalance_sources", []):
                source_id = frozen["run_id"]
                source = session.scalar(select(Run).where(Run.id == source_id, Run.user_id == run.user_id))
                source_input = session.scalar(select(EvidenceRecord).where(EvidenceRecord.user_id == run.user_id, EvidenceRecord.id == frozen["input_id"]))
                source_outputs = list(session.scalars(select(EvidenceRecord).where(EvidenceRecord.user_id == run.user_id, EvidenceRecord.id.in_(frozen["output_ids"]))))
                if source and source_input and source_outputs and frozen["coverage"] == "complete":
                    build_decisions(session, source, source_input, source_outputs, formula=Formula.model_validate(inp.payload["formula"]) if inp.payload.get("formula") else None, technical_map=agreed, revision=f"technical:{run.id}", completion_at=max((o.payload.get("available_at") or "" for o in outputs), default="") or None)
