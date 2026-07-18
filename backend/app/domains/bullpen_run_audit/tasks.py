from __future__ import annotations

from datetime import UTC, datetime
import time
from typing import Any

from app.core.logging import get_logger
from app.domains.ai_providers.factory import ProviderFactory
from app.domains.bullpen_run_audit.prompt_builder import (
    build_feedback_chunk_prompt,
    build_feedback_synthesis_prompt,
    parse_feedback_report,
    plan_feedback_chunks,
)
from app.domains.bullpen_run_audit.repository import BullpenRunAuditRepository
from app.domains.bullpen_run_audit.service import materialize_run_audit_snapshot_sync
from app.domains.polymarket.bullpen_llm_execution import prompt_budget_chars_for_provider
from app.infrastructure.database.sync_session import SyncSessionLocal
from app.infrastructure.messaging.celery_app import celery
import app.infrastructure.database.all_models  # noqa: F401

logger = get_logger("app.domains.bullpen_run_audit.tasks")


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _coverage_pct(section_keys: list[str], total_sections: int) -> float:
    unique_keys = {key.split("#", 1)[0] for key in section_keys}
    if total_sections <= 0:
        return 0.0
    return round((len(unique_keys) / total_sections) * 100, 2)


@celery.task(
    bind=True,
    max_retries=2,
    default_retry_delay=60,
    soft_time_limit=60 * 30,
    time_limit=(60 * 30) + 60,
    name="app.domains.bullpen_run_audit.tasks.generate_bullpen_run_audit_feedback",
    queue="ai",
)
def generate_bullpen_run_audit_feedback(
    self,
    *,
    user_id: int,
    run_id: str,
    feedback_id: int,
) -> None:
    with SyncSessionLocal() as session:
        repo = BullpenRunAuditRepository(session)
        feedback = repo.get_feedback(user_id=user_id, feedback_id=feedback_id)
        if feedback is None:
            logger.warning("Run audit feedback %s no longer exists", feedback_id)
            return
        feedback.status = "processing"
        session.flush()

        try:
            target_health = ProviderFactory.validate_target(feedback.provider, feedback.model)
            if not target_health.available:
                raise ValueError(target_health.reason or "Selected provider target is unavailable.")

            materialized = materialize_run_audit_snapshot_sync(
                session,
                user_id=user_id,
                run_id=run_id,
                force=False,
            )
            bundle = materialized.bundle
            snapshot = materialized.snapshot
            provider = ProviderFactory.create(feedback.provider)
            prompt_budget = max(10_000, int(prompt_budget_chars_for_provider(feedback.provider) * 0.72))
            chunks = plan_feedback_chunks(bundle=bundle, max_chars=prompt_budget)
            feedback.chunk_count = len(chunks)
            total_sections = len(bundle.keys()) - 1  # exclude metadata
            total_tokens_in = 0
            total_tokens_out = 0
            total_cost = 0.0
            total_latency = 0.0
            chunk_reports: list[dict[str, Any]] = []

            for chunk_index, chunk in enumerate(chunks, start=1):
                started = time.perf_counter()
                prompt = build_feedback_chunk_prompt(
                    snapshot_hash=snapshot.canonical_bundle_hash,
                    chunk_index=chunk_index,
                    chunk_count=len(chunks),
                    section_keys=list(chunk["section_keys"]),
                    payload=dict(chunk["payload"]),
                )
                input_blob = repo.create_blob(payload=prompt, content_type="text/plain")
                response = provider.generate(prompt=prompt, model=feedback.model)
                raw_output_blob = repo.create_blob(
                    payload=response.content,
                    content_type="text/plain",
                )
                parsed = parse_feedback_report(response.content)
                elapsed = round(time.perf_counter() - started, 3)
                total_tokens_in += int(response.tokens_in or 0)
                total_tokens_out += int(response.tokens_out or 0)
                total_cost = round(total_cost + float(response.cost or 0), 6)
                total_latency = round(total_latency + elapsed, 3)
                subcall = BullpenRunAuditFeedbackSubcallRecord(
                    feedback_id=feedback.id,
                    chunk_index=chunk_index,
                    section_keys_json=list(chunk["section_keys"]),
                    status="completed",
                    provider=feedback.provider,
                    model=feedback.model,
                    prompt_hash=feedback.prompt_hash,
                    input_blob_id=input_blob.id,
                    raw_output_blob_id=raw_output_blob.id,
                    parsed_output_json=parsed,
                    tokens_in=int(response.tokens_in or 0),
                    tokens_out=int(response.tokens_out or 0),
                    estimated_cost=float(response.cost or 0),
                    latency_seconds=elapsed,
                    coverage_pct=_coverage_pct(list(chunk["section_keys"]), total_sections),
                    error_message=None,
                )
                session.add(subcall)
                session.flush()
                chunk_reports.append(
                    {
                        "chunk_index": chunk_index,
                        "section_keys": list(chunk["section_keys"]),
                        "coverage_pct": subcall.coverage_pct,
                        "report": parsed,
                    }
                )

            final_report = chunk_reports[0]["report"] if len(chunk_reports) == 1 else None
            final_raw_output = None
            if len(chunk_reports) > 1:
                started = time.perf_counter()
                synthesis_prompt = build_feedback_synthesis_prompt(
                    snapshot_hash=snapshot.canonical_bundle_hash,
                    chunk_reports=chunk_reports,
                )
                input_blob = repo.create_blob(
                    payload=synthesis_prompt,
                    content_type="text/plain",
                )
                response = provider.generate(prompt=synthesis_prompt, model=feedback.model)
                raw_output_blob = repo.create_blob(
                    payload=response.content,
                    content_type="text/plain",
                )
                final_report = parse_feedback_report(response.content)
                elapsed = round(time.perf_counter() - started, 3)
                total_tokens_in += int(response.tokens_in or 0)
                total_tokens_out += int(response.tokens_out or 0)
                total_cost = round(total_cost + float(response.cost or 0), 6)
                total_latency = round(total_latency + elapsed, 3)
                final_raw_output = response.content
                session.add(
                    BullpenRunAuditFeedbackSubcallRecord(
                        feedback_id=feedback.id,
                        chunk_index=len(chunk_reports) + 1,
                        section_keys_json=["synthesis"],
                        status="completed",
                        provider=feedback.provider,
                        model=feedback.model,
                        prompt_hash=feedback.prompt_hash,
                        input_blob_id=input_blob.id,
                        raw_output_blob_id=raw_output_blob.id,
                        parsed_output_json=final_report,
                        tokens_in=int(response.tokens_in or 0),
                        tokens_out=int(response.tokens_out or 0),
                        estimated_cost=float(response.cost or 0),
                        latency_seconds=elapsed,
                        coverage_pct=100.0,
                        error_message=None,
                    )
                )
            if final_report is None:
                raise ValueError("Feedback synthesis did not produce a final report.")

            feedback.status = "completed"
            feedback.chunk_coverage_pct = 100.0
            feedback.tokens_in = total_tokens_in
            feedback.tokens_out = total_tokens_out
            feedback.estimated_cost = total_cost
            feedback.latency_seconds = total_latency
            feedback.error_message = None
            feedback.report_json = final_report
            feedback.codex_prompt = str(final_report.get("codex_prompt") or "")
            feedback.completed_at = _utc_now()
            if final_raw_output:
                feedback.raw_output_blob_id = repo.create_blob(
                    payload=final_raw_output,
                    content_type="text/plain",
                ).id
            feedback.report_blob_id = repo.create_blob(
                payload=final_report,
                content_type="application/json",
            ).id
            snapshot.feedback_status = feedback.status
            snapshot.feedback_provider = feedback.provider
            snapshot.feedback_model = feedback.model
            session.commit()
        except Exception as exc:
            logger.exception("Run audit feedback generation failed for %s", feedback_id)
            if int(getattr(self.request, "retries", 0) or 0) < int(self.max_retries or 0):
                feedback.error_message = str(exc)
                session.commit()
                raise self.retry(exc=exc)
            feedback.status = "failed"
            feedback.error_message = str(exc)
            feedback.completed_at = _utc_now()
            feedback.chunk_coverage_pct = min(feedback.chunk_coverage_pct or 0, 100.0)
            if feedback.snapshot is not None:
                feedback.snapshot.feedback_status = feedback.status
                feedback.snapshot.feedback_provider = feedback.provider
                feedback.snapshot.feedback_model = feedback.model
            session.commit()

