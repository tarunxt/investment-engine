from copy import deepcopy
import pytest
from sqlalchemy import select
from app.domains.runs.stock_observations import stock_observation_page
from app.domains.recommendation_audit.capture import freeze_input, freeze_output
from app.domains.runs.models import RunJob
from app.shared.types import JobStatus
from test_recommendation_audit_integration import db, source  # noqa: F401


def pages(db, user=1, symbol='FIXTUREEQ', limit=1):
    cursor, all_rows, seen = None, {}, set()
    while True:
        page = stock_observation_page(db, user_id=user, market='india', symbol=symbol, cursor=cursor, limit=limit)
        for row in page['items']: all_rows.setdefault(row['id'], row)
        if not page['has_more']: return list(all_rows.values())
        cursor = page['next_cursor']
        assert cursor not in seen
        seen.add(cursor)


def test_all_pages_include_newer_failed_partial_and_separate_models_without_history_projection(db):
    run1, job1 = source(db)
    run2, job2 = source(db)
    run2.status = JobStatus.FAILED; job2.status = JobStatus.PARTIAL
    run3, job3 = source(db)
    job3.model = 'second-model'; db.commit()
    original = [job.response for job in [job1, job2, job3]]
    rows = pages(db)
    assert {row['run_id'] for row in rows} == {run1.id, run2.id, run3.id}
    assert rows[0]['run_id'] == run3.id
    assert next(row for row in rows if row['run_id'] == run2.id)['job_status'] == 'partial'
    assert next(row for row in rows if row['run_id'] == run2.id)['run_status'] == 'failed'
    assert [job.response for job in [job1, job2, job3]] == original
    assert len(pages(db, symbol='OTHER')) == 0


def test_owner_market_and_exact_symbol_are_required(db):
    source(db); source(db, user=2)
    assert len(pages(db)) == 1
    assert len(pages(db, user=2)) == 1
    assert len(pages(db, user=3)) == 0
    assert len(pages(db, symbol='FIXTURE')) == 0
    page = stock_observation_page(db, user_id=1, market='us', symbol='FIXTUREEQ')
    assert page['items'] == []


def test_immutable_retention_and_raw_job_have_stable_dedup_identity(db):
    run, job = source(db)
    inp = freeze_input(db, run, [job]); output = freeze_output(db, run, job, inp); db.commit()
    rows = pages(db)
    assert len(rows) == 1
    original_cells = deepcopy(rows[0]['cells'])
    for link in list(db.scalars(select(RunJob))): db.delete(link)
    db.delete(job); db.delete(run); db.commit()
    retained = pages(db)
    assert len(retained) == 1 and retained[0]['cells'] == original_cells
    assert retained[0]['id'] == rows[0]['id']
    assert retained[0]['run_status'] == 'original run status unavailable'
    assert retained[0]['source'] == 'retained_immutable_output'
    assert output.content


def test_cursor_validation_and_empty_pages_reach_audit_phase(db):
    with pytest.raises(ValueError): stock_observation_page(db, user_id=1, market='india', symbol='X', cursor='jobs:bad')
    with pytest.raises(ValueError): stock_observation_page(db, user_id=1, market='india', symbol='X', cursor='invalid:0')
    assert pages(db) == []


def test_technical_rows_need_no_action_column_and_malformed_rows_keep_every_cell(db):
    from app.domains.runs.stock_observations import matching_rows
    technical = "| Stock Symbol | Confidence | Rationale |\n|---|---|---|\n| HAL | 2 | Original technical rationale |"
    assert matching_rows(technical, 'HAL')[0][1]['confidence'] == '2'
    escaped = "| Stock Symbol | Rationale |\n|---|---|\n| HAL | Breakout \\| original |"
    assert matching_rows(escaped, 'HAL')[0][1]['rationale'] == 'Breakout | original'
    malformed = "| Stock Symbol | Score |\n|---|---|\n| HAL | 2 | additional financial cell |"
    row = matching_rows(malformed, 'HAL')[0][1]
    assert row['original cells'] == ['HAL', '2', 'additional financial cell']
    assert 'score' not in row and 'Malformed' in row['source contract status']
    assert matching_rows('HAL is mentioned in retained narrative.', 'HAL')[0][1]['original source text'].startswith('HAL')
    assert matching_rows(technical.replace('HAL', 'HALOTHER'), 'HAL') == []
