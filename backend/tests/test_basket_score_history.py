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


@pytest.mark.parametrize('stage', ['Swing', 'Technical', 'Threats'])
def test_already_persisted_overall_score_is_eligible_from_any_completed_stage(db, stage):
    FinalActionableHistory.__table__.create(db.bind)
    run, _ = source(db)
    run.auto_rebalance_label = f'India Run 1 ({stage} Scan)'
    run.prompt = f'India {stage} Scan'
    add(db, run, AS_OF, score=1.75)
    result = score_history_view(db, user_id=1, market='india', symbols=['FIXTUREEQ'], days=5, as_of=AS_OF, timezone_name='UTC')
    assert len(result['observations']) == 1
    assert result['observations'][0]['completed'] is True
    assert result['observations'][0]['score'] == 1.75
    run.status = JobStatus.PARTIAL
    db.commit()
    assert score_history_view(db, user_id=1, market='india', symbols=['FIXTUREEQ'], days=5, as_of=AS_OF, timezone_name='UTC')['observations'][0]['completed'] is False


def test_raw_parameter_or_confidence_values_do_not_create_overall_scores(db):
    FinalActionableHistory.__table__.create(db.bind)
    run, job = source(db)
    run.auto_rebalance_label = 'India Run 1 (Technical Scan)'
    run.prompt = '## Technical Scan Input Bundle\nMarket: India equities'
    job.response = '| Exchange | Stock Symbol | Confidence | Score Rationale Technical Setup |\n|---|---|---|---|\n| NSE | FIXTUREEQ | 7.7 | 2.5 |'
    db.commit()
    assert score_history_view(db, user_id=1, market='india', symbols=['FIXTUREEQ'], days=5, as_of=AS_OF, timezone_name='UTC')['observations'] == []


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


def captured_queries(as_of=AS_OF):
    class Capture:
        def __init__(self): self.queries = []
        def execute(self, query): self.queries.append(query); return self
        def all(self): return []
    session = Capture()
    score_history_view(session, user_id=1, market='india', symbols=['HAL'], days=5, as_of=as_of, timezone_name='Asia/Kolkata')
    return session.queries


def test_window_bindings_match_aware_history_and_naive_utc_run_storage():
    from sqlalchemy.dialects.postgresql.asyncpg import PGDialect_asyncpg
    offset = timezone(timedelta(hours=5, minutes=30))
    queries = captured_queries(AS_OF.astimezone(offset))
    bounds = [[value for value in query.compile(dialect=PGDialect_asyncpg()).params.values() if isinstance(value, datetime)] for query in queries]
    assert bounds[0] == [AS_OF-timedelta(days=5), AS_OF]
    assert all(value.tzinfo is not None for value in bounds[0])
    assert bounds[1] == [(AS_OF-timedelta(days=5)).replace(tzinfo=None), AS_OF.replace(tzinfo=None)]
    assert all(value.tzinfo is None for value in bounds[1])


import os
from pathlib import Path
from test_recommendation_audit_postgres import engine  # noqa: F401

@pytest.mark.skipif(not os.getenv('CREDX_AUDIT_TEST_POSTGRES_URL') or os.getenv('CREDX_AUDIT_DISPOSABLE_DB') != '1' or not Path('/.dockerenv').exists(), reason='Disposable PostgreSQL Docker test environment not provided')
def test_real_asyncpg_window_queries_keep_boundary_and_owner_semantics(engine):
    import asyncio
    import asyncpg
    from sqlalchemy.dialects.postgresql.asyncpg import PGDialect_asyncpg
    from app.domains.recommendation_audit.models import DecisionRecord
    schema = engine.get_execution_options()['schema_translate_map'][None]
    dsn = os.environ['CREDX_AUDIT_TEST_POSTGRES_URL'].replace('postgresql+psycopg2://','postgresql://')
    async def check():
        connection = await asyncpg.connect(dsn)
        try:
            await connection.execute(f'SET search_path TO "{schema}"')
            await connection.execute('CREATE TABLE runs (id INTEGER PRIMARY KEY, user_id INTEGER, created_at TIMESTAMP WITHOUT TIME ZONE); CREATE TABLE final_actionable_history (id INTEGER PRIMARY KEY, user_id INTEGER, market VARCHAR(16), stock_symbol VARCHAR(64), rebalance_run_id INTEGER, covered_at TIMESTAMP WITH TIME ZONE)')
            with pytest.raises(asyncpg.DataError):
                await connection.fetchval('SELECT $1::TIMESTAMP WITHOUT TIME ZONE', AS_OF)
            start = AS_OF-timedelta(days=5)
            await connection.executemany('INSERT INTO runs VALUES ($1,$2,$3)', [(1,1,AS_OF.replace(tzinfo=None)), (2,1,start.replace(tzinfo=None)), (3,2,AS_OF.replace(tzinfo=None))])
            await connection.executemany('INSERT INTO final_actionable_history VALUES ($1,$2,$3,$4,$5,$6)', [(1,1,'india','HAL',1,AS_OF), (2,1,'india','HAL',2,start), (3,2,'india','HAL',3,AS_OF)])
            await connection.execute("INSERT INTO recommendation_decisions (id,user_id,run_id,market,symbol,exchange,decision_at,captured_at,provenance,content_hash,payload) SELECT 'decision-'||id::text,user_id,id,'india','HAL','NSE',now(),now(),'prospective',md5(id::text)||md5(id::text),'{}'::json FROM runs")
            for query, column in zip(captured_queries(AS_OF.astimezone(timezone(timedelta(hours=5,minutes=30)))), [FinalActionableHistory.id,DecisionRecord.id]):
                compiled = query.with_only_columns(column).compile(dialect=PGDialect_asyncpg(), compile_kwargs={'render_postcompile':True})
                rows = await connection.fetch(str(compiled), *(compiled.params[key] for key in compiled.positiontup))
                assert len(rows) == 1
                assert rows[0][0] in (1,'decision-1')
        finally: await connection.close()
    asyncio.run(check())


def test_saved_partial_score_is_eligible_without_claiming_run_completed(db):
    FinalActionableHistory.__table__.create(db.bind)
    run, _ = source(db)
    run.status = JobStatus.PARTIAL
    add(db, run, AS_OF, score=1.75)
    def read():
        return score_history_view(db, user_id=1, market='india', symbols=['FIXTUREEQ'], days=5, as_of=AS_OF, timezone_name='UTC')['observations'][0]
    assert read()['eligible'] is True
    assert read()['completed'] is False
    assert read()['run_status'] == 'partial'
    run.status = JobStatus.FAILED
    db.commit()
    assert read()['eligible'] is False
