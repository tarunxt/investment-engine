"""Freeze authorized Swing membership evidence outside the model prompt."""
from __future__ import annotations

from dataclasses import asdict, replace
import json
from types import SimpleNamespace
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.jobs.models import Job
from app.domains.jobs.output_contracts import source_hash
from app.domains.jobs.output_contracts.consistency import FrozenSwingSource, freeze_swing_source
from app.domains.runs.models import Run, RunJob
from app.domains.runs.run_identity import analysis_run_identity
from app.shared.exceptions import ValidationException
from app.shared.types import JobStatus


SOURCE_CONTEXT_KIND = "equity_output_sources_v1"
MAX_OUTPUT_SOURCE_JOBS = 200
MAX_OUTPUT_SOURCE_BYTES = 2_000_000
MAX_OUTPUT_SOURCE_CONTEXT_BYTES = 500_000
MAX_OUTPUT_SOURCE_IDENTITIES = 20_000
MAX_OUTPUT_SOURCE_IDENTITY_CHARS = 128


class OutputSourceJobReference(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    run_id: int = Field(ge=1, le=9_007_199_254_740_991)
    job_id: int = Field(ge=1, le=9_007_199_254_740_991)
    response_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


async def freeze_output_source_context(
    session: AsyncSession, *, user_id: int, target: Any,
    references: list[OutputSourceJobReference] | None,
) -> dict[str, Any] | None:
    """Read only explicitly selected, owned DB rows before any job is created.

    Source snapshots remain valid across historical workflow sequences. The raw
    response hash binds the frontend's selected content to this exact DB version.
    Missing, conflicting or inaccessible references never fall back to latest.
    """
    if references is None:
        return None
    target_identity = analysis_run_identity(target)
    if target_identity.stage != "rebalance" or target_identity.market not in {"india", "us"}:
        raise ValidationException("Output source references require an identified equity rebalance run.")
    if len(references) > MAX_OUTPUT_SOURCE_JOBS:
        raise ValidationException(f"At most {MAX_OUTPUT_SOURCE_JOBS} output source references are supported.")
    unique: dict[int, OutputSourceJobReference] = {}
    for reference in references:
        previous = unique.get(reference.job_id)
        if previous is not None and previous != reference:
            raise ValidationException("Conflicting output source references; refresh selected inputs.")
        unique[reference.job_id] = reference
    records = []
    if unique:
        # Project bounded metadata before reading any response text. Never hydrate
        # ORM Run/Job entities here: their prompts, outputs and contexts are large.
        columns = [RunJob.run_id.label("link_run_id"), RunJob.job_id.label("link_job_id"),
                   func.octet_length(Job.response).label("response_bytes"),
                   select(func.count(RunJob.id)).where(RunJob.run_id == Run.id)
                   .correlate(Run).scalar_subquery().label("run_member_count")]
        for prefix, model in (("run", Run), ("job", Job)):
            columns.extend(getattr(model, field).label(f"{prefix}_{field}") for field in
                           ("id", "user_id", "status", "auto_rebalance_portfolio", "auto_rebalance_label"))
            columns.append(func.left(model.prompt, 1000).label(f"{prefix}_prompt"))
        query = (select(*columns).select_from(RunJob)
                 .join(Run, Run.id == RunJob.run_id)
                 .join(Job, Job.id == RunJob.job_id)
                 .where(Run.user_id == user_id, Job.user_id == user_id,
                        or_(*(and_(RunJob.run_id == ref.run_id, RunJob.job_id == ref.job_id)
                              for ref in unique.values())))
                 .limit(MAX_OUTPUT_SOURCE_JOBS + 1))
        records = list((await session.execute(query)).mappings().all())
    found: dict[int, tuple[Any, Any, int]] = {}
    source_bytes = 0
    for record in records:
        run, job = (SimpleNamespace(**{key[len(prefix) + 1:]: value for key, value in record.items()
                                     if key.startswith(prefix + "_")}) for prefix in ("run", "job"))
        ref = unique.get(job.id)
        if (ref is None or job.id in found or record["link_run_id"] != ref.run_id or record["link_job_id"] != ref.job_id
                or run.id != ref.run_id or job.user_id != user_id or run.user_id != user_id):
            raise ValidationException("Output source linkage is unavailable or ambiguous; refresh selected inputs.")
        for source in (run, job):
            source_identity = analysis_run_identity(source)
            if source_identity.stage != "swing" or source_identity.market != target_identity.market:
                raise ValidationException("Output sources must be Swing runs and jobs in the same market.")
            if source.status not in {JobStatus.COMPLETED, JobStatus.PARTIAL}:
                raise ValidationException("Output sources must be completed or partial; wait or refresh selected inputs.")
        size = record["response_bytes"]
        if not isinstance(size, int) or size < 1:
            raise ValidationException("An output source has no saved response; refresh selected inputs.")
        source_bytes += size
        if source_bytes > MAX_OUTPUT_SOURCE_BYTES:
            raise ValidationException(f"Selected output sources exceed {MAX_OUTPUT_SOURCE_BYTES} UTF-8 bytes; reduce the selection.")
        found[job.id] = (run, job, size)
    if set(found) != set(unique):
        raise ValidationException("An output source is unavailable to this user; refresh selected inputs.")
    responses: dict[int, str] = {}
    if found:
        # The per-ID byte constraint also handles growth between these two reads:
        # changed-size responses are not hydrated and force a fresh selection.
        response_query = (select(Job.id, Job.response).where(
            Job.user_id == user_id,
            or_(*(and_(Job.id == job_id, Job.status == job.status,
                       func.octet_length(Job.response) == size)
                  for job_id, (_, job, size) in found.items())),
        ).limit(MAX_OUTPUT_SOURCE_JOBS))
        responses = dict((await session.execute(response_query)).all())
        if set(responses) != set(found):
            raise ValidationException("A selected Swing response changed; refresh selected inputs before starting.")
    sources = []
    for job_id, ref in unique.items():
        run, job, _ = found[job_id]
        response = responses[job_id]
        if not isinstance(response, str) or not response.strip():
            raise ValidationException("An output source has no saved response; refresh selected inputs.")
        if source_hash(response) != ref.response_sha256:
            raise ValidationException("A selected Swing response changed; refresh selected inputs before starting.")
        frozen = freeze_swing_source(job.id, response, complete=job.status == JobStatus.COMPLETED)
        frozen = replace(frozen, run_id=run.id, market=target_identity.market)
        sources.append({"source_status": job.status.value, "run_status": run.status.value,
                        "run_member_count": run.member_count, **asdict(frozen)})
    for entry in sources:
        members = [source for source in sources if source["run_id"] == entry["run_id"]]
        entry["run_complete"] = (entry["run_status"] == "completed"
                                 and entry["run_member_count"] == len(members)
                                 and all(member["complete"] for member in members))
    context = {"kind": SOURCE_CONTEXT_KIND, "market": target_identity.market, "sources": sources}
    if len(json.dumps(context, ensure_ascii=False).encode("utf-8")) > MAX_OUTPUT_SOURCE_CONTEXT_BYTES:
        raise ValidationException("Frozen output source evidence exceeds the supported size; reduce the selection.")
    if frozen_sources_from_context(context, market=target_identity.market) is None:
        raise ValidationException("Frozen output source identities exceed the supported bounds; reduce the selection.")
    return context


def frozen_sources_from_context(context: Any, *, market: str | None) -> tuple[FrozenSwingSource, ...] | None:
    """Read a server-created context; old or malformed contexts stay unknown."""
    if market not in {"india", "us"} or not isinstance(context, dict) or context.get("kind") != SOURCE_CONTEXT_KIND or context.get("market") != market:
        return None
    entries = context.get("sources")
    if not isinstance(entries, list) or len(entries) > MAX_OUTPUT_SOURCE_JOBS:
        return None
    try:
        if len(json.dumps(context, ensure_ascii=False).encode("utf-8")) > MAX_OUTPUT_SOURCE_CONTEXT_BYTES:
            return None
    except (TypeError, ValueError, RecursionError):
        return None
    sources = []
    seen: set[int] = set()
    identity_count = 0
    for entry in entries:
        if not isinstance(entry, dict):
            return None
        try:
            OutputSourceJobReference(run_id=entry.get("run_id"), job_id=entry.get("job_id"),
                                     response_sha256=entry.get("response_hash"))
            identities = entry["identities"]
            if entry["job_id"] in seen:
                return None
            seen.add(entry["job_id"])
            identity_count += len(identities)
            if identity_count > MAX_OUTPUT_SOURCE_IDENTITIES:
                return None
            if (not isinstance(identities, (list, tuple)) or not isinstance(entry.get("complete"), bool)
                    or entry.get("parsing_status") not in {"valid", "partial", "blocked"}
                    or entry.get("source_status") not in {"completed", "partial"}
                    or type(entry.get("run_complete")) is not bool
                    or type(entry.get("run_member_count")) is not int or entry["run_member_count"] < 1
                    or entry.get("run_status") not in {"completed", "partial"}
                    or entry.get("market") != market
                    or entry["complete"] and not identities
                    or entry["complete"] and (entry["parsing_status"] != "valid" or entry["source_status"] != "completed")
                    or any(not isinstance(key, (list, tuple)) or len(key) != 2
                           or any(not isinstance(part, str) or not part.strip()
                                  or len(part) > MAX_OUTPUT_SOURCE_IDENTITY_CHARS for part in key)
                           for key in identities)):
                return None
            finding_counts = entry.get("finding_counts")
            if (not isinstance(finding_counts, dict) or len(finding_counts) > 100
                    or any(not isinstance(key, str) or len(key) > 128 or type(count) is not int or count < 0
                           for key, count in finding_counts.items())):
                return None
            sources.append(FrozenSwingSource(entry["job_id"], entry["response_hash"],
                                            tuple(tuple(key) for key in identities), entry["complete"],
                                            entry["parsing_status"], entry.get("finding_counts"),
                                            entry["run_id"], entry["run_complete"], market))
        except (KeyError, ValueError, TypeError):
            return None
    for entry in entries:
        members = [item for item in entries if item["run_id"] == entry["run_id"]]
        if any(item["run_member_count"] != entry["run_member_count"] or item["run_status"] != entry["run_status"]
               or item["run_complete"] != entry["run_complete"] for item in members):
            return None
        if entry["run_complete"] and (entry["run_member_count"] != len(members)
                                      or entry["run_status"] != "completed" or not all(item["complete"] for item in members)):
            return None
    return tuple(sources)
