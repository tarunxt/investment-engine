from __future__ import annotations
from contextlib import contextmanager
from datetime import timedelta
from decimal import Decimal
import logging
from sqlalchemy import and_, or_, select, update
from app.core.recovery import require_audit_request_allowed, RecoveryBlocked, recovery_mode
from .capture import add_evidence
from .deterministic import compare
from .ledger import reserve, settle
from .models import EvidenceRecord, VerificationRecord, utcnow
from .service import owned_decision
from .verdict import candle_observations, claims_for, evaluate, aware

logger = logging.getLogger(__name__)


def claim_lease(session, record_id):
    now = utcnow()
    changed = session.execute(update(VerificationRecord).where(VerificationRecord.id == record_id, or_(VerificationRecord.status == "queued", and_(VerificationRecord.status == "processing", VerificationRecord.lease_until < now))).values(status="processing", lease_until=now + timedelta(seconds=180), fence=VerificationRecord.fence + 1, dispatch_pending=False).execution_options(synchronize_session=False))
    session.commit()
    if changed.rowcount != 1: return None
    return session.get(VerificationRecord, record_id, populate_existing=True)


def finish(session, record_id, fence, result=None, error=None):
    changed = session.execute(update(VerificationRecord).where(VerificationRecord.id == record_id, VerificationRecord.status == "processing", VerificationRecord.fence == fence, VerificationRecord.lease_until > utcnow()).values(status="completed" if result else "failed", verdict=result.get("verdict") if result else None, result=result, error=error, completed_at=utcnow(), lease_until=None, dispatch_pending=False).execution_options(synchronize_session=False))
    if changed.rowcount == 1:
        record = session.get(VerificationRecord, record_id, populate_existing=True)
        add_evidence(session, user_id=record.user_id, kind="verification", source_key=f"verification:{record_id}:{fence}", run_id=None, payload={"fence": fence, "request_hash": record.request_hash, "result": result, "error": error})
        session.commit()
        return True
    session.rollback()
    return False


def run_verification(session, record_id, settings, *, external_collector=None):
    candidate = session.get(VerificationRecord, record_id, populate_existing=True)
    if not candidate: return False
    try: require_audit_request_allowed(candidate.request, settings, record=candidate)
    except RecoveryBlocked: return False
    record = claim_lease(session, record_id)
    if not record: return False
    fence = record.fence
    try:
        current = owned_decision(session, record.user_id, record.current_id)
        previous = owned_decision(session, record.user_id, record.previous_id) if record.previous_id else None
        if not current or (record.previous_id and not previous): raise ValueError("Owned immutable evidence no longer available")
        comparison = compare(previous.payload, current.payload) if previous else None
        claims = claims_for(current.payload)
        observations, sources, limitations = [], [], []
        if record.request["mode"] == "external_data":
            if not settings.recommendation_audit_external_enabled: limitations.append("External verification disabled")
            else:
                collector = external_collector or collect_external
                observations, sources, limitations = collector(session, record, fence, current, claims, settings)
        result = evaluate(current.payload, comparison, claims, observations)
        result.update(comparison=comparison, sources=sources, limitations=limitations, bundle_hash=record.request["bundle_hash"], mode=record.request["mode"], checked_at=utcnow().isoformat())
        # Incomplete collection cannot yield a positive verdict.
        if limitations and result["verdict"] == "supported": result["verdict"] = "insufficient_evidence"
        return finish(session, record_id, fence, result=result)
    except Exception as exc:
        session.rollback()
        logger.exception("Recommendation verification %s failed", record_id)
        return finish(session, record_id, fence, error=f"{type(exc).__name__}: verification failed; inspect server logs")


def collect_external(session, record, fence, current, claims, settings):
    # Defense in depth, including callers that bypass the queue task.
    if recovery_mode(): raise RecoveryBlocked("External audit data during recovery")
    from .adapters import kite_read, rbi_read
    import requests
    observations, sources, limitations = [], [], []
    request_count = 0

    def transport_for(adapter, per_request_cost):
        @contextmanager
        def transport(url, **kwargs):
            nonlocal request_count
            request_count += 1
            if request_count > 3: raise ValueError("Verification request ceiling exceeded")
            attempt = reserve(session, record.id, fence, attempt_key=f"{adapter}:{request_count}", adapter=adapter, tariff_version=f"{adapter}-fixed-incremental-v1:{per_request_cost}", upper_bound=per_request_cost, daily_cap=settings.recommendation_audit_daily_cap_usd)
            try:
                with requests.get(url, **kwargs) as response:
                    yield response
                settle(session, attempt, actual=per_request_cost)
            except BaseException:
                # Includes transport timeouts/soft task interruption. No paid automatic retries.
                settle(session, attempt, actual=None)
                raise
        return transport

    if current.market == "india":
        if settings.recommendation_audit_kite_incremental_cost_usd is None:
            limitations.append("Kite incremental tariff/entitlement not configured; no request made")
        else:
            try:
                from app.domains.zerodha.models import ZerodhaCredential
                from app.domains.zerodha.crypto import decrypt_token
                credential = session.scalar(select(ZerodhaCredential).where(ZerodhaCredential.user_id == record.user_id))
                if not credential or aware(credential.expires_at) <= utcnow() or not settings.zerodha_api_key: raise ValueError("Existing Kite authorization unavailable or expired; no refresh is performed")
                source = kite_read(current.payload, api_key=settings.zerodha_api_key, access_token=decrypt_token(credential.access_token), transport=transport_for("kite", Decimal(str(settings.recommendation_audit_kite_incremental_cost_usd))))
                sources.append(source)
                observations.extend(candle_observations(claims, source["candles"], decision_at=current.payload["decision_at"], source_id=source["source_id"], source_url=source["source_url"], content_hash=source["content_hash"], observed_at=aware(source["observed_at"])))
                limitations.extend(source["limitations"])
            except Exception as exc:
                limitations.append(f"Kite check unavailable: {type(exc).__name__}; no completed-close certification")
                logger.warning("Kite verification unavailable for %s (%s)", record.id, type(exc).__name__)
    else: limitations.append("US market data adapter not configured")
    # Follow only captured official URLs, not invented searches or model-proposed endpoints.
    inputs = session.scalar(select(EvidenceRecord).where(EvidenceRecord.id == current.payload.get("input_id"), EvidenceRecord.user_id == record.user_id))
    text = inputs.content if inputs and inputs.content else ""
    import re
    if current.market=="india" and getattr(settings,"recommendation_audit_fundamentals_enabled",False):
        from .fundamentals import read_fundamentals_filing,official_filing_url
        filing_urls=[url.rstrip(".,)") for url in re.findall(r"https://nsearchives\.nseindia\.com/corporate/[^\s<>|]+",text)]
        filing_urls=[url for url in filing_urls if official_filing_url(url)]
        if filing_urls:
            try:
                source=read_fundamentals_filing(filing_urls[0],transport=transport_for("nse-filing",Decimal(0)))
                metadata={k:v for k,v in source.items() if k!="content"}
                add_evidence(session,user_id=record.user_id,kind="external",source_key=f"verification:{record.id}:nse-filing",run_id=current.run_id,payload=metadata,content=source["content"])
                sources.append(metadata);limitations.extend(source["limitations"])
            except Exception as exc:
                limitations.append(f"NSE fundamentals filing unavailable: {type(exc).__name__}; no semantic certification")
        else: limitations.append("No exact official XBRL filing URL in frozen inputs; no fundamentals request made")
    urls = re.findall(r"https://www\.rbi\.org\.in/scripts/BS_PressReleaseDisplay\.aspx\?prid=[1-9][0-9]{0,8}(?![0-9])", text)
    if urls and request_count<3:
        try:
            source = rbi_read(urls[0], transport=transport_for("rbi", Decimal(0)))
            # Save full bounded bytes as tenant evidence; response displays metadata only.
            add_evidence(session, user_id=record.user_id, kind="external", source_key=f"verification:{record.id}:rbi", run_id=current.run_id, payload={k: v for k, v in source.items() if k != "content"}, content=source["content"])
            sources.append({k: v for k, v in source.items() if k != "content"})
            limitations.extend(source["limitations"])
        except Exception as exc: limitations.append(f"RBI evidence unavailable: {type(exc).__name__}")
    elif urls: limitations.append("Public request slot used by fundamentals filing; RBI context not fetched")
    return observations, sources, limitations
