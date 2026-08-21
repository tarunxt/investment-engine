from __future__ import annotations

from datetime import UTC, datetime
import hashlib
import json
import re
from typing import Any

from sqlalchemy import Select, and_, delete, desc, func, or_, select
from sqlalchemy.dialects.postgresql import insert as postgresql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session, selectinload

from app.domains.bullpen_run_audit.models import (
    BullpenRunAuditBlobRecord,
    BullpenRunAuditEventRecord,
    BullpenRunAuditFeedbackRecord,
    BullpenRunAuditFeedbackSubcallRecord,
    BullpenRunAuditFindingRecord,
    BullpenRunAuditFormulaRecord,
    BullpenRunAuditManualCheckRecord,
    BullpenRunAuditRemarkRecord,
    BullpenRunAuditSnapshotRecord,
    BullpenRunAuditStageRecord,
)
from app.domains.bullpen_run_audit.sanitizer import sanitize_secret_value
from app.domains.polymarket_auto_live.models import (
    PolymarketAutoLiveDecisionRecord,
    PolymarketAutoLiveOrderIntentRecord,
    PolymarketAutoLiveRunRecord,
)
from app.domains.polymarket_auto_live.repository import (
    visible_auto_live_decision_filter,
)


_ABSOLUTE_FILESYSTEM_PATH_PATTERN = re.compile(
    r"(?<![A-Za-z0-9:/])"
    r"(?:"
    r"/(?:Users|home|root|etc|var|opt|srv|tmp|private)"
    r"(?:/[^\s'\"<>;,)]*)+"
    r"|"
    r"[A-Za-z]:\\(?:Users|home|root|etc|var|opt|srv|tmp|private)"
    r"(?:\\[^\s'\"<>;,)]*)+"
    r")",
    re.IGNORECASE,
)


def _redact_host_paths(value: Any) -> Any:
    """Apply the path-only pass to an already secret-sanitized value."""

    sanitized = value
    if isinstance(sanitized, str):
        return _ABSOLUTE_FILESYSTEM_PATH_PATTERN.sub(
            "[REDACTED_PATH]",
            sanitized,
        )
    if isinstance(sanitized, dict):
        return {
            str(key): _redact_host_paths(item)
            for key, item in sanitized.items()
        }
    if isinstance(sanitized, list):
        return [_redact_host_paths(item) for item in sanitized]
    return sanitized


def sanitize_audit_evidence(value: Any) -> Any:
    """Redact secrets and host filesystem identity from persisted evidence.

    Secret-key sanitization deliberately preserves ordinary strings. Runtime
    failures can nevertheless embed an absolute credential or environment
    path inside an otherwise safe message, so audit persistence applies this
    second, narrow pass for common Unix and Windows host roots. JSON pointers
    such as ``/stage_3/order_intents`` and repository-relative source paths
    remain intact.
    """

    return _redact_host_paths(sanitize_secret_value(value))


def utc_now() -> datetime:
    return datetime.now(UTC)


def isoformat(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat()


def stable_blob_id(payload: Any) -> str:
    if isinstance(payload, str):
        value = str(sanitize_audit_evidence(payload))
    else:
        value = json.dumps(
            sanitize_audit_evidence(payload),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class BullpenRunAuditRepository:
    def __init__(self, session: Session) -> None:
        self.session = session

    def list_run_records(
        self,
        *,
        user_id: int,
        run_status: str | None = None,
        triggered_by: str | None = None,
        dry_live_mode: str | None = None,
        from_date: datetime | None = None,
        to_date: datetime | None = None,
        run_id_search: str | None = None,
    ) -> list[PolymarketAutoLiveRunRecord]:
        query: Select[tuple[PolymarketAutoLiveRunRecord]] = select(PolymarketAutoLiveRunRecord).where(
            PolymarketAutoLiveRunRecord.user_id == user_id
        )
        if run_status:
            query = query.where(PolymarketAutoLiveRunRecord.status == run_status)
        if triggered_by:
            query = query.where(PolymarketAutoLiveRunRecord.triggered_by == triggered_by)
        if dry_live_mode == "dry":
            query = query.where(PolymarketAutoLiveRunRecord.dry_run.is_(True))
        elif dry_live_mode == "live":
            query = query.where(PolymarketAutoLiveRunRecord.dry_run.is_(False))
        if from_date is not None:
            query = query.where(PolymarketAutoLiveRunRecord.started_at >= from_date)
        if to_date is not None:
            query = query.where(PolymarketAutoLiveRunRecord.started_at <= to_date)
        if run_id_search:
            query = query.where(PolymarketAutoLiveRunRecord.id.ilike(f"%{run_id_search.strip()}%"))
        query = query.order_by(
            desc(PolymarketAutoLiveRunRecord.started_at),
            desc(PolymarketAutoLiveRunRecord.created_at),
        )
        return list(self.session.execute(query).scalars().all())

    def get_run_record(self, *, user_id: int, run_id: str) -> PolymarketAutoLiveRunRecord | None:
        return self.session.execute(
            select(PolymarketAutoLiveRunRecord).where(
                and_(
                    PolymarketAutoLiveRunRecord.user_id == user_id,
                    PolymarketAutoLiveRunRecord.id == run_id,
                )
            )
        ).scalar_one_or_none()

    def lock_run_record_for_audit_materialization(
        self,
        *,
        user_id: int,
        run_id: str,
    ) -> PolymarketAutoLiveRunRecord | None:
        """Load a run under the materialization serialization lock.

        The run is the stable, already-existing parent for every audit
        snapshot.  Locking it rather than a snapshot row also serializes the
        first snapshot creation, when there is no snapshot row to lock yet.

        PostgreSQL holds ``FOR UPDATE`` until the caller commits or rolls back
        its transaction.  SQLite deliberately accepts this query as a no-op
        for local/unit-test compatibility; production uses PostgreSQL.
        """

        query = (
            select(PolymarketAutoLiveRunRecord)
            .where(
                and_(
                    PolymarketAutoLiveRunRecord.user_id == user_id,
                    PolymarketAutoLiveRunRecord.id == run_id,
                )
            )
            .with_for_update()
        )
        return self.session.execute(query).scalar_one_or_none()

    def get_run_decision_records(
        self,
        *,
        user_id: int,
        run_id: str,
    ) -> list[PolymarketAutoLiveDecisionRecord]:
        query = (
            select(PolymarketAutoLiveDecisionRecord)
            .where(
                and_(
                    PolymarketAutoLiveDecisionRecord.user_id == user_id,
                    PolymarketAutoLiveDecisionRecord.run_id == run_id,
                )
            )
            .where(visible_auto_live_decision_filter())
            .order_by(
                desc(PolymarketAutoLiveDecisionRecord.created_at),
                desc(PolymarketAutoLiveDecisionRecord.updated_at),
            )
        )
        return list(self.session.execute(query).scalars().all())

    def get_run_order_intent_records(
        self,
        *,
        user_id: int,
        run_id: str,
    ) -> list[PolymarketAutoLiveOrderIntentRecord]:
        query = (
            select(PolymarketAutoLiveOrderIntentRecord)
            .where(
                and_(
                    PolymarketAutoLiveOrderIntentRecord.user_id == user_id,
                    PolymarketAutoLiveOrderIntentRecord.run_id == run_id,
                )
            )
            .options(selectinload(PolymarketAutoLiveOrderIntentRecord.attempts))
            .options(selectinload(PolymarketAutoLiveOrderIntentRecord.reservations))
            .order_by(desc(PolymarketAutoLiveOrderIntentRecord.created_at))
        )
        return list(self.session.execute(query).scalars().unique().all())

    def get_current_snapshot(
        self,
        *,
        user_id: int,
        run_id: str,
    ) -> BullpenRunAuditSnapshotRecord | None:
        query = (
            select(BullpenRunAuditSnapshotRecord)
            .where(
                and_(
                    BullpenRunAuditSnapshotRecord.user_id == user_id,
                    BullpenRunAuditSnapshotRecord.run_id == run_id,
                    BullpenRunAuditSnapshotRecord.is_current.is_(True),
                )
            )
            .options(selectinload(BullpenRunAuditSnapshotRecord.findings))
            .options(selectinload(BullpenRunAuditSnapshotRecord.feedback_generations))
            .order_by(desc(BullpenRunAuditSnapshotRecord.snapshot_version))
            .limit(1)
        )
        return self.session.execute(query).scalar_one_or_none()

    def get_snapshot(
        self,
        *,
        user_id: int,
        snapshot_id: int,
    ) -> BullpenRunAuditSnapshotRecord | None:
        query = (
            select(BullpenRunAuditSnapshotRecord)
            .where(
                and_(
                    BullpenRunAuditSnapshotRecord.user_id == user_id,
                    BullpenRunAuditSnapshotRecord.id == snapshot_id,
                )
            )
            .options(selectinload(BullpenRunAuditSnapshotRecord.stages))
            .options(selectinload(BullpenRunAuditSnapshotRecord.events))
            .options(selectinload(BullpenRunAuditSnapshotRecord.formulas))
            .options(selectinload(BullpenRunAuditSnapshotRecord.findings))
            .options(selectinload(BullpenRunAuditSnapshotRecord.remarks))
            .options(selectinload(BullpenRunAuditSnapshotRecord.manual_checks))
            .options(selectinload(BullpenRunAuditSnapshotRecord.feedback_generations))
        )
        return self.session.execute(query).scalar_one_or_none()

    def create_blob(
        self,
        *,
        payload: Any,
        content_type: str,
        sanitized: bool = True,
    ) -> BullpenRunAuditBlobRecord:
        sanitized_payload = sanitize_audit_evidence(payload)
        blob_id = stable_blob_id(sanitized_payload)
        existing = self.session.get(BullpenRunAuditBlobRecord, blob_id)
        if existing is not None:
            return existing
        if isinstance(sanitized_payload, str):
            payload_json = None
            payload_text = sanitized_payload
            size_bytes = len(payload_text.encode("utf-8"))
        else:
            payload_json = sanitized_payload
            payload_text = None
            size_bytes = len(
                json.dumps(payload_json, ensure_ascii=False, sort_keys=True).encode("utf-8")
            )
        values = {
            "id": blob_id,
            "content_type": content_type,
            "sanitized": sanitized,
            "size_bytes": size_bytes,
            "payload_json": payload_json,
            "payload_text": payload_text,
        }
        dialect_name = self.session.get_bind().dialect.name
        if dialect_name == "postgresql":
            # Content-addressed blobs can be shared by independent run audit
            # transactions.  Let the stable content hash be the idempotency
            # key instead of turning a harmless concurrent insert into an
            # IntegrityError that rolls back the snapshot rebuild.
            self.session.execute(
                postgresql_insert(BullpenRunAuditBlobRecord)
                .values(**values)
                .on_conflict_do_nothing(index_elements=[BullpenRunAuditBlobRecord.id])
            )
            self.session.flush()
            record = self.session.get(BullpenRunAuditBlobRecord, blob_id)
            if record is None:  # pragma: no cover - defensive database invariant
                raise RuntimeError(f"Failed to materialize audit blob {blob_id}")
            return record
        if dialect_name == "sqlite":
            self.session.execute(
                sqlite_insert(BullpenRunAuditBlobRecord)
                .values(**values)
                .on_conflict_do_nothing(index_elements=[BullpenRunAuditBlobRecord.id])
            )
            self.session.flush()
            record = self.session.get(BullpenRunAuditBlobRecord, blob_id)
            if record is None:  # pragma: no cover - defensive database invariant
                raise RuntimeError(f"Failed to materialize audit blob {blob_id}")
            return record

        # Non-production dialect fallback used by lightweight test doubles.
        record = BullpenRunAuditBlobRecord(**values)
        self.session.add(record)
        self.session.flush()
        return record

    @staticmethod
    def unreferenced_blob_ids_query(
        *,
        created_before: datetime,
        batch_size: int,
    ) -> Select[tuple[str]]:
        """Select an age-bounded batch of blobs with no durable references.

        Snapshot materialization deliberately replaces mutable child rows while
        retaining immutable content-addressed blobs.  This query is the
        reference boundary for reclaiming the old payloads: every blob-bearing
        foreign key must remain absent before a blob can be deleted.
        """

        blob_id = BullpenRunAuditBlobRecord.id
        references = (
            (
                BullpenRunAuditSnapshotRecord,
                BullpenRunAuditSnapshotRecord.canonical_bundle_blob_id,
            ),
            (BullpenRunAuditStageRecord, BullpenRunAuditStageRecord.inputs_blob_id),
            (BullpenRunAuditStageRecord, BullpenRunAuditStageRecord.outputs_blob_id),
            (BullpenRunAuditStageRecord, BullpenRunAuditStageRecord.raw_stage_blob_id),
            (BullpenRunAuditEventRecord, BullpenRunAuditEventRecord.payload_blob_id),
            (
                BullpenRunAuditFeedbackRecord,
                BullpenRunAuditFeedbackRecord.raw_output_blob_id,
            ),
            (
                BullpenRunAuditFeedbackRecord,
                BullpenRunAuditFeedbackRecord.report_blob_id,
            ),
            (
                BullpenRunAuditFeedbackSubcallRecord,
                BullpenRunAuditFeedbackSubcallRecord.input_blob_id,
            ),
            (
                BullpenRunAuditFeedbackSubcallRecord,
                BullpenRunAuditFeedbackSubcallRecord.raw_output_blob_id,
            ),
        )
        no_references = tuple(
            ~select(1)
            .select_from(model)
            .where(reference_column == blob_id)
            .correlate(BullpenRunAuditBlobRecord)
            .exists()
            for model, reference_column in references
        )
        return (
            select(blob_id)
            .where(
                BullpenRunAuditBlobRecord.created_at < created_before,
                *no_references,
            )
            .order_by(
                BullpenRunAuditBlobRecord.created_at.asc(),
                blob_id.asc(),
            )
            .limit(max(1, int(batch_size)))
        )

    def delete_unreferenced_blobs_older_than(
        self,
        *,
        created_before: datetime,
        batch_size: int,
    ) -> int:
        """Delete one retry-safe batch of old, unreferenced audit blobs."""

        candidate_ids = self.unreferenced_blob_ids_query(
            created_before=created_before,
            batch_size=batch_size,
        )
        result = self.session.execute(
            delete(BullpenRunAuditBlobRecord).where(
                BullpenRunAuditBlobRecord.id.in_(candidate_ids)
            )
        )
        return max(0, int(getattr(result, "rowcount", 0) or 0))

    def clear_current_snapshot_children(self, snapshot_id: int) -> None:
        self.session.query(BullpenRunAuditStageRecord).filter(
            BullpenRunAuditStageRecord.snapshot_id == snapshot_id
        ).delete(synchronize_session=False)
        self.session.query(BullpenRunAuditEventRecord).filter(
            BullpenRunAuditEventRecord.snapshot_id == snapshot_id
        ).delete(synchronize_session=False)
        self.session.query(BullpenRunAuditFormulaRecord).filter(
            BullpenRunAuditFormulaRecord.snapshot_id == snapshot_id
        ).delete(synchronize_session=False)
        self.session.query(BullpenRunAuditFindingRecord).filter(
            BullpenRunAuditFindingRecord.snapshot_id == snapshot_id
        ).delete(synchronize_session=False)
        # A force rebuild inserts deterministic child keys (notably events)
        # immediately afterwards.  Flush the deletes while the owning run row
        # remains locked, so a retry cannot observe a half-cleared snapshot or
        # collide with a still-pending unique event key.
        self.session.flush()

    def latest_snapshot_version_for_run(self, *, user_id: int, run_id: str) -> int:
        value = self.session.execute(
            select(func.max(BullpenRunAuditSnapshotRecord.snapshot_version)).where(
                and_(
                    BullpenRunAuditSnapshotRecord.user_id == user_id,
                    BullpenRunAuditSnapshotRecord.run_id == run_id,
                )
            )
        ).scalar_one_or_none()
        return int(value or 0)

    def demote_current_snapshots(self, *, user_id: int, run_id: str) -> None:
        self.session.query(BullpenRunAuditSnapshotRecord).filter(
            and_(
                BullpenRunAuditSnapshotRecord.user_id == user_id,
                BullpenRunAuditSnapshotRecord.run_id == run_id,
                BullpenRunAuditSnapshotRecord.is_current.is_(True),
            )
        ).update({"is_current": False}, synchronize_session=False)

    def latest_feedback_for_snapshot(
        self,
        *,
        snapshot_id: int,
        provider: str,
        model: str,
        prompt_version: str,
        snapshot_hash: str | None,
    ) -> BullpenRunAuditFeedbackRecord | None:
        query = (
            select(BullpenRunAuditFeedbackRecord)
            .where(
                and_(
                    BullpenRunAuditFeedbackRecord.snapshot_id == snapshot_id,
                    BullpenRunAuditFeedbackRecord.provider == provider,
                    BullpenRunAuditFeedbackRecord.model == model,
                    BullpenRunAuditFeedbackRecord.prompt_version == prompt_version,
                    BullpenRunAuditFeedbackRecord.snapshot_hash == snapshot_hash,
                )
            )
            .order_by(desc(BullpenRunAuditFeedbackRecord.created_at))
            .limit(1)
        )
        return self.session.execute(query).scalar_one_or_none()

    def latest_feedback_for_snapshot_any(
        self,
        *,
        snapshot_id: int,
    ) -> BullpenRunAuditFeedbackRecord | None:
        query = (
            select(BullpenRunAuditFeedbackRecord)
            .where(BullpenRunAuditFeedbackRecord.snapshot_id == snapshot_id)
            .order_by(desc(BullpenRunAuditFeedbackRecord.created_at))
            .limit(1)
        )
        return self.session.execute(query).scalar_one_or_none()

    def get_feedback(
        self,
        *,
        user_id: int,
        feedback_id: int,
    ) -> BullpenRunAuditFeedbackRecord | None:
        query = (
            select(BullpenRunAuditFeedbackRecord)
            .join(BullpenRunAuditSnapshotRecord)
            .where(
                and_(
                    BullpenRunAuditFeedbackRecord.id == feedback_id,
                    BullpenRunAuditSnapshotRecord.user_id == user_id,
                )
            )
            .options(selectinload(BullpenRunAuditFeedbackRecord.subcalls))
        )
        return self.session.execute(query).scalar_one_or_none()

    def list_feedback_for_snapshot(
        self,
        *,
        snapshot_id: int,
    ) -> list[BullpenRunAuditFeedbackRecord]:
        query = (
            select(BullpenRunAuditFeedbackRecord)
            .where(BullpenRunAuditFeedbackRecord.snapshot_id == snapshot_id)
            .order_by(desc(BullpenRunAuditFeedbackRecord.created_at))
        )
        return list(self.session.execute(query).scalars().all())

    def list_snapshots_query(
        self,
        *,
        user_id: int,
        stage_failure: str | None = None,
        audit_status: str | None = None,
        finding_severity: str | None = None,
        feedback_generated: bool | None = None,
        run_status: str | None = None,
        triggered_by: str | None = None,
        dry_live_mode: str | None = None,
        from_date: datetime | None = None,
        to_date: datetime | None = None,
        run_id_search: str | None = None,
    ) -> Select[tuple[BullpenRunAuditSnapshotRecord]]:
        query = select(BullpenRunAuditSnapshotRecord).where(
            and_(
                BullpenRunAuditSnapshotRecord.user_id == user_id,
                BullpenRunAuditSnapshotRecord.is_current.is_(True),
            )
        )
        if run_status:
            query = query.where(BullpenRunAuditSnapshotRecord.run_status == run_status)
        if triggered_by:
            query = query.where(BullpenRunAuditSnapshotRecord.triggered_by == triggered_by)
        if dry_live_mode == "dry":
            query = query.where(BullpenRunAuditSnapshotRecord.dry_run.is_(True))
        elif dry_live_mode == "live":
            query = query.where(BullpenRunAuditSnapshotRecord.dry_run.is_(False))
        if from_date is not None:
            query = query.where(BullpenRunAuditSnapshotRecord.started_at >= from_date)
        if to_date is not None:
            query = query.where(BullpenRunAuditSnapshotRecord.started_at <= to_date)
        if run_id_search:
            query = query.where(BullpenRunAuditSnapshotRecord.run_id.ilike(f"%{run_id_search.strip()}%"))
        if stage_failure == "stage-1":
            query = query.where(BullpenRunAuditSnapshotRecord.stage1_status == "fail")
        elif stage_failure == "stage-2":
            query = query.where(BullpenRunAuditSnapshotRecord.stage2_status == "fail")
        elif stage_failure == "stage-3":
            query = query.where(BullpenRunAuditSnapshotRecord.stage3_status == "fail")
        if audit_status:
            query = query.where(BullpenRunAuditSnapshotRecord.audit_status == audit_status)
        if feedback_generated is True:
            query = query.where(
                BullpenRunAuditSnapshotRecord.feedback_status.in_(("completed", "processing", "queued"))
            )
        elif feedback_generated is False:
            query = query.where(BullpenRunAuditSnapshotRecord.feedback_status.is_(None))
        if finding_severity:
            severity_field = {
                "critical": BullpenRunAuditSnapshotRecord.findings_critical,
                "high": BullpenRunAuditSnapshotRecord.findings_high,
                "medium": BullpenRunAuditSnapshotRecord.findings_medium,
                "low": BullpenRunAuditSnapshotRecord.findings_low,
                "info": BullpenRunAuditSnapshotRecord.findings_info,
            }.get(finding_severity)
            if severity_field is not None:
                query = query.where(severity_field > 0)
        return query.order_by(
            desc(BullpenRunAuditSnapshotRecord.started_at),
            desc(BullpenRunAuditSnapshotRecord.created_at),
        )

    def list_latest_remarks(self, *, snapshot_id: int) -> list[BullpenRunAuditRemarkRecord]:
        query = (
            select(BullpenRunAuditRemarkRecord)
            .where(BullpenRunAuditRemarkRecord.snapshot_id == snapshot_id)
            .order_by(desc(BullpenRunAuditRemarkRecord.created_at))
        )
        return list(self.session.execute(query).scalars().all())

    def list_manual_checks(self, *, snapshot_id: int) -> list[BullpenRunAuditManualCheckRecord]:
        query = (
            select(BullpenRunAuditManualCheckRecord)
            .where(BullpenRunAuditManualCheckRecord.snapshot_id == snapshot_id)
            .order_by(desc(BullpenRunAuditManualCheckRecord.created_at))
        )
        return list(self.session.execute(query).scalars().all())
