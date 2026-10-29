from datetime import datetime, timedelta, timezone
import pytest
from app.domains.runs.basket_score_history import score_history_view
from app.domains.runs.models import FinalActionableHistory
from app.shared.types import JobStatus
from test_recommendation_audit_integration import db, source  # noqa: F401

AS_OF = datetime(2026, 10, 28, 18, tzinfo=timezone.utc)

def add(db, run, when, score=2.5, venue='NSE'):
    row = FinalActionableHistory(user_id=run.user_id, rebalance_run_id=run.id, market='india', stock_symbol='FIXTUREEQ', covered_at=when, formula_version='score-matrix-v1', formula_inputs_json={'stockExchange': venue}, coverage_status='suggested', score=score, action='Hold')
    db.add(row); db.commit(); return row


def test_window_is_half_open_and_every_completed_run_is_retained_without_daily_averaging(db):
    FinalActionableHistory.__table__.create(db.bind)
    for offset, score in [(0, 3), (1, 1), (2, -1), (5, 2), (6, 2)]:
        run, _ = source(db); add(db, run, AS_OF-timedelta(days=offset), score)
    run, _ = source(db, user=2); add(db, run, AS_OF, 99)
    result = score_history_view(db, user_id=1, market='india', symbols=['FIXTUREEQ'], days=5, as_of=AS_OF, timezone_name='Asia/Kolkata')
    assert len(result['observations']) == 3
    assert [row['score'] for row in result['observations']] == [-1, 1, 3]
    assert all(row['completed'] for row in result['observations'])
    assert not result['truncated']


def test_failed_partial_deleted_and_wrong_market_sources_are_not_completed(db):
    FinalActionableHistory.__table__.create(db.bind)
    run, _ = source(db); run.status = JobStatus.PARTIAL; add(db, run, AS_OF)
    result = score_history_view(db, user_id=1, market='india', symbols=['FIXTUREEQ'], days=5, as_of=AS_OF, timezone_name='UTC')
    assert result['observations'][0]['completed'] is False
    assert result['observations'][0]['exchange'] == 'NSE'
    assert score_history_view(db, user_id=2, market='india', symbols=['FIXTUREEQ'], days=5, as_of=AS_OF, timezone_name='UTC')['observations'] == []
    assert score_history_view(db, user_id=1, market='us', symbols=['FIXTUREEQ'], days=5, as_of=AS_OF, timezone_name='UTC')['observations'] == []


def test_invalid_window_or_timezone_never_defaults_to_a_different_scope(db):
    for overrides in [{'days':0}, {'days':3651}, {'as_of': AS_OF.replace(tzinfo=None)}, {'timezone_name':'Invalid/Zone'}, {'symbols':[]}]:
        with pytest.raises(ValueError): score_history_view(db, **({'user_id':1,'market':'india','symbols':['HAL'],'days':5,'as_of':AS_OF,'timezone_name':'UTC'} | overrides))


def test_original_complete_immutable_scores_are_read_without_history_writes_or_latest_revision_guess(db):
    from copy import deepcopy
    from sqlalchemy import select
    from app.domains.recommendation_audit.capture import freeze_input, capture_terminal
    from app.domains.recommendation_audit.schemas import AuditRunContext
    from app.domains.recommendation_audit.models import DecisionRecord
    from test_recommendation_audit import formula
    FinalActionableHistory.__table__.create(db.bind)
    run, job = source(db)
    run.created_at = AS_OF - timedelta(hours=1)
    freeze_input(db, run, [job], AuditRunContext(formula=formula()))
    capture_terminal(db, job); db.commit()
    decision = db.scalar(select(DecisionRecord))
    read = lambda: score_history_view(db, user_id=1, market='india', symbols=['FIXTUREEQ'], days=5, as_of=AS_OF, timezone_name='UTC')
    first = read(); assert len(first['observations']) == 1
    assert first['observations'][0]['score'] == float(decision.payload['calculation']['score'])
    assert first['observations'][0]['formula_version'] == 'immutable-captured-formula'
    assert list(db.scalars(select(FinalActionableHistory))) == []
    payload = deepcopy(decision.payload); payload['calculation']['score'] = '2.83'
    db.add(DecisionRecord(user_id=1, run_id=run.id, market='india', symbol='FIXTUREEQ', exchange='NSE', decision_at=decision.decision_at, provenance=decision.provenance, content_hash='a'*64, payload=payload)); db.commit()
    assert read()['observations'] == []
    assert read()['ambiguous_complete_runs'] == 1
