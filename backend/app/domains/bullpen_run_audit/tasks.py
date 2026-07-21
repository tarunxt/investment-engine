from __future__ import annotations

from datetime import UTC, datetime
import os
import threading
import time
from typing import Any
from uuid import uuid4

import redis as sync_redis

from app.core.config import settings
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


_AUDIT_REFRESH_NAMESPACE = "bullpen:run-audit:refresh"
_DELETE_IF_OWNER_SCRIPT = (
    "if redis.call('get', KEYS[1]) == ARGV[1] "
    "then return redis.call('del', KEYS[1]) "
    "else return 0 end"
)
_RENEW_IF_OWNER_SCRIPT = (
    "if redis.call('get', KEYS[1]) == ARGV[1] "
    "then return redis.call('expire', KEYS[1], ARGV[2]) "
    "else return 0 end"
)


def _positive_int_env(name: str, default: int, *, minimum: int = 1) -> int:
    """Read a bounded duration without making audit refresh fatal."""

    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    try:
        return max(minimum, int(raw_value))
    except (TypeError, ValueError):
        logger.warning("Invalid %s=%r; using %s", name, raw_value, default)
        return default


def audit_refresh_debounce_seconds() -> int:
    return _positive_int_env(
        "BULLPEN_RUN_AUDIT_REFRESH_DEBOUNCE_SECONDS",
        5,
        minimum=0,
    )


def audit_refresh_lease_seconds() -> int:
    return _positive_int_env("BULLPEN_RUN_AUDIT_REFRESH_LEASE_SECONDS", 300)


def _audit_refresh_pending_ttl_seconds() -> int:
    # Keep the scheduling marker alive for the debounce window plus a complete
    # refresh lease.  This is deliberately longer than the countdown so a
    # redelivered Celery message still has one canonical owner token.
    return max(
        30,
        audit_refresh_debounce_seconds() + audit_refresh_lease_seconds() + 60,
    )


def _audit_refresh_key(kind: str, run_id: str) -> str:
    return f"{_AUDIT_REFRESH_NAMESPACE}:{kind}:{run_id}"


def _audit_refresh_redis_client() -> sync_redis.Redis:
    return sync_redis.from_url(settings.redis_url, decode_responses=True)


def _delete_if_owner(
    redis_client: sync_redis.Redis,
    *,
    key: str,
    token: str,
) -> None:
    """Release a Redis key only if it is still owned by this task token."""

    redis_client.eval(_DELETE_IF_OWNER_SCRIPT, 1, key, token)


def _renew_if_owner(
    redis_client: sync_redis.Redis,
    *,
    key: str,
    token: str,
    ttl_seconds: int,
) -> bool:
    """Extend a refresh marker only while this task still owns its token."""

    renewed = redis_client.eval(
        _RENEW_IF_OWNER_SCRIPT,
        1,
        key,
        token,
        max(1, int(ttl_seconds)),
    )
    return int(renewed or 0) == 1


class _AuditRefreshLeaseHeartbeat:
    """Keep a long force-materialization coalesced behind its Redis token.

    A snapshot rebuild can legitimately spend longer than the initial lease
    while it waits for the database serialization lock.  This heartbeat keeps
    the pending marker and per-run lease alive without making audit rendering
    a correctness dependency for order reconciliation.
    """

    def __init__(
        self,
        *,
        redis_client: sync_redis.Redis,
        pending_key: str,
        lease_key: str,
        token: str,
        lease_ttl_seconds: int,
        pending_ttl_seconds: int,
    ) -> None:
        self._redis_client = redis_client
        self._pending_key = pending_key
        self._lease_key = lease_key
        self._token = token
        self._lease_ttl_seconds = lease_ttl_seconds
        self._pending_ttl_seconds = pending_ttl_seconds
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self.ownership_lost = False

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(
            target=self._run,
            name=f"bullpen-audit-refresh-lease-{self._lease_key.rsplit(':', 1)[-1][:12]}",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)

    def _run(self) -> None:
        interval = max(5.0, min(60.0, self._lease_ttl_seconds / 3))
        while not self._stop_event.wait(interval):
            try:
                lease_renewed = _renew_if_owner(
                    self._redis_client,
                    key=self._lease_key,
                    token=self._token,
                    ttl_seconds=self._lease_ttl_seconds,
                )
                pending_renewed = _renew_if_owner(
                    self._redis_client,
                    key=self._pending_key,
                    token=self._token,
                    ttl_seconds=self._pending_ttl_seconds,
                )
            except Exception:
                logger.warning(
                    "Could not renew coalesced Bullpen run-audit refresh lease for %s",
                    self._lease_key,
                    exc_info=True,
                )
                self.ownership_lost = True
                return
            if lease_renewed and pending_renewed:
                continue
            self.ownership_lost = True
            logger.warning(
                "Lost coalesced Bullpen run-audit refresh lease ownership for %s",
                self._lease_key,
            )
            return


def request_bullpen_run_audit_refresh_sync(
    *,
    user_id: int,
    run_id: str,
    freeze: bool = False,
) -> bool:
    """Coalesce an eventual force refresh for one Auto-Live run.

    Order reconciliation remains correct if this best-effort audit request is
    unavailable: it only schedules a view of already-durable state.  Redis is
    intentionally fail-closed here so a Redis outage cannot turn every order
    poll into a full audit rebuild storm.

    Returns ``True`` only for the caller that created the pending marker and
    therefore enqueued the single Celery refresh task.  Later requests for the
    same run during the debounce/active window cheaply return ``False``.
    """

    normalized_run_id = str(run_id).strip()
    if not normalized_run_id:
        raise ValueError("run_id is required for Bullpen run-audit refresh")

    pending_key = _audit_refresh_key("pending", normalized_run_id)
    freeze_key = _audit_refresh_key("freeze", normalized_run_id)
    token = str(uuid4())
    redis_client: sync_redis.Redis | None = None
    try:
        redis_client = _audit_refresh_redis_client()
        if freeze:
            # A later cancellation must not be weakened by an earlier
            # non-freezing refresh request.  It is intentionally left to TTL
            # expiry instead of deleting it from a racing worker.
            redis_client.set(
                freeze_key,
                "1",
                ex=_audit_refresh_pending_ttl_seconds(),
            )
        acquired = redis_client.set(
            pending_key,
            token,
            nx=True,
            ex=_audit_refresh_pending_ttl_seconds(),
        )
        if not acquired:
            return False

        refresh_bullpen_run_audit_snapshot.apply_async(  # type: ignore[attr-defined]
            kwargs={
                "user_id": int(user_id),
                "run_id": normalized_run_id,
                "request_token": token,
                "freeze_requested": bool(freeze),
            },
            queue="ai",
            countdown=audit_refresh_debounce_seconds(),
        )
        return True
    except Exception:
        # Do not fall back to a direct force materialization.  The audit is
        # observational and must never consume Stage 3 worker capacity or
        # affect durable order reconciliation on a broker/cache failure.
        logger.exception(
            "Unable to queue coalesced Bullpen run-audit refresh for run %s",
            normalized_run_id,
        )
        if redis_client is not None:
            try:
                _delete_if_owner(redis_client, key=pending_key, token=token)
            except Exception:
                logger.warning(
                    "Unable to clear failed Bullpen run-audit refresh marker for run %s",
                    normalized_run_id,
                    exc_info=True,
                )
        return False
    finally:
        if redis_client is not None:
            redis_client.close()


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _coverage_pct(section_keys: list[str], total_sections: int) -> float:
    unique_keys = {key.split("#", 1)[0] for key in section_keys}
    if total_sections <= 0:
        return 0.0
    return round((len(unique_keys) / total_sections) * 100, 2)


@celery.task(
    bind=True,
    max_retries=0,
    soft_time_limit=60 * 10,
    time_limit=(60 * 10) + 30,
    name="app.domains.bullpen_run_audit.tasks.refresh_bullpen_run_audit_snapshot",
    queue="ai",
)
def refresh_bullpen_run_audit_snapshot(
    self,
    *,
    user_id: int,
    run_id: str,
    request_token: str,
    freeze_requested: bool = False,
) -> str:
    """Materialize one coalesced, current audit view for a run.

    The Redis pending marker deduplicates scheduling and the per-run lease
    makes duplicate/redelivered Celery messages a cheap no-op.  Database
    serialization in ``materialize_run_audit_snapshot_sync`` remains the
    correctness boundary, including if Redis loses state or a lease expires.
    """

    normalized_run_id = str(run_id).strip()
    token = str(request_token).strip()
    if not normalized_run_id or not token:
        logger.warning("Ignoring malformed Bullpen run-audit refresh task")
        return "invalid"

    pending_key = _audit_refresh_key("pending", normalized_run_id)
    lease_key = _audit_refresh_key("lease", normalized_run_id)
    freeze_key = _audit_refresh_key("freeze", normalized_run_id)
    redis_client: sync_redis.Redis | None = None
    lease_acquired = False
    lease_heartbeat: _AuditRefreshLeaseHeartbeat | None = None
    try:
        redis_client = _audit_refresh_redis_client()
        if redis_client.get(pending_key) != token:
            logger.info(
                "Skipping superseded Bullpen run-audit refresh for run %s",
                normalized_run_id,
            )
            return "superseded"

        lease_acquired = bool(
            redis_client.set(
                lease_key,
                token,
                nx=True,
                ex=audit_refresh_lease_seconds(),
            )
        )
        if not lease_acquired:
            logger.info(
                "Skipping duplicate Bullpen run-audit refresh while lease is active for run %s",
                normalized_run_id,
            )
            return "duplicate"

        lease_heartbeat = _AuditRefreshLeaseHeartbeat(
            redis_client=redis_client,
            pending_key=pending_key,
            lease_key=lease_key,
            token=token,
            lease_ttl_seconds=audit_refresh_lease_seconds(),
            pending_ttl_seconds=_audit_refresh_pending_ttl_seconds(),
        )
        lease_heartbeat.start()

        # ``freeze`` is monotonic within the coalescing window: a cancellation
        # request can only add the terminal/frozen behavior, never remove it.
        # Let the materializer derive terminal freezing from the latest
        # persisted run unless a cancellation request explicitly requires it.
        # Passing ``False`` here would incorrectly override a run that became
        # terminal while this debounced task was waiting for its row lock.
        freeze = (
            True
            if (freeze_requested or redis_client.get(freeze_key) == "1")
            else None
        )
        with SyncSessionLocal() as session:
            materialize_run_audit_snapshot_sync(
                session,
                user_id=int(user_id),
                run_id=normalized_run_id,
                force=True,
                freeze=freeze,
            )
            session.commit()
        logger.debug(
            "Coalesced Bullpen run-audit refresh completed for run %s",
            normalized_run_id,
        )
        return "materialized"
    except Exception:
        # Audit refresh failures are visible and actionable, but must not make
        # order reconciliation retry, resubmit, or otherwise change execution
        # behavior.  A later state transition or UI materialization can retry.
        logger.exception(
            "Coalesced Bullpen run-audit refresh failed for run %s",
            normalized_run_id,
        )
        return "failed"
    finally:
        if lease_heartbeat is not None:
            lease_heartbeat.stop()
        if redis_client is not None:
            try:
                if lease_acquired:
                    _delete_if_owner(redis_client, key=lease_key, token=token)
                    _delete_if_owner(redis_client, key=pending_key, token=token)
            except Exception:
                logger.warning(
                    "Unable to release Bullpen run-audit refresh lease for run %s",
                    normalized_run_id,
                    exc_info=True,
                )
            finally:
                redis_client.close()


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
            snapshot_id = materialized.snapshot.id
            snapshot_hash = materialized.snapshot.canonical_bundle_hash
            # The materializer obtains the per-run PostgreSQL row lock.  Make
            # the snapshot and the feedback "processing" state durable before
            # invoking an AI provider, rather than retaining that lock for a
            # potentially long provider call.
            session.commit()
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
                    snapshot_hash=snapshot_hash,
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
                    snapshot_hash=snapshot_hash,
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
            snapshot = repo.get_snapshot(user_id=user_id, snapshot_id=snapshot_id)
            if snapshot is not None:
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
