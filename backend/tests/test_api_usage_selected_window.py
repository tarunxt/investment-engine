"""Actual SQLAlchemy persisted-row reads; SQLite memory only, no services."""
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
from sqlalchemy import insert
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

import app.models  # canonical mappings; no DB connections
from app.domains.api_usage.corrected_router import _window_attempt_coverage
from app.domains.api_usage.models import ApiUsageAttemptEvent
from app.domains.api_usage.provenance import tariff_provenance
from app.domains.api_usage import metering
from app.domains.api_usage.recorder import reset_provider_usage_context, set_provider_usage_context
from app.domains.ai_providers.deepseek import DeepSeekProvider

START = datetime(2026, 10, 31, tzinfo=UTC)
RATES = {'cache_hit_input': .0028, 'cache_miss_input': .14, 'output': .28}


def event(index, **changes):
    row = dict(event_id=f'{index:08d}', attempt_id=f'attempt-{index}', event_kind='finished',
        user_id=17, requested_provider='deepseek', requested_model='requested', actual_provider='deepseek',
        actual_model='actual', phase='request', started_at=START + timedelta(seconds=index),
        finished_at=START + timedelta(seconds=index+1), status='success',
        instrumentation_scope='sdk_call_hidden_retries_unknown',
        reported_usage={'input_tokens':100,'output_tokens':0},
        inferred_usage={'cache_read_input_tokens':0,'cache_miss_input_tokens':100,
            'coverage':{'version':1,'usage_status':'reported','cost_status':'estimated_token_only','cost_reason':'listed_token_tariff'}},
        tariff_rates=RATES, tariff_estimated_cost_usd=.000014)
    row.update(changes)
    return row


@pytest.mark.asyncio
async def test_complete_stream_preserves_rows_and_identity_beyond_old_limit(monkeypatch):
    monkeypatch.setattr('socket.socket.connect', Mock(side_effect=AssertionError('offline')))
    engine = create_async_engine('sqlite+aiosqlite://')
    try:
        async with engine.begin() as connection:
            await connection.run_sync(ApiUsageAttemptEvent.__table__.create)
            rows = [event(i) for i in range(10_005)]
            # Independent samples remain independent, even with identical usage.
            rows[0]['provider_response_id'] = 'same-response'
            rows[-1].update(duplicate_of_attempt_id='attempt-0', provider_response_id='same-response', tariff_estimated_cost_usd=None)
            rows[1].update(status='error', reported_usage=None, tariff_estimated_cost_usd=None)
            rows[2].update(status='cancelled', reported_usage=None, tariff_estimated_cost_usd=None)
            # Not included: another owner/provider, before window, exclusive end.
            rows += [event(20000, user_id=18), event(20001, actual_provider='openai'),
                     event(20002, started_at=START-timedelta(seconds=2), finished_at=START-timedelta(seconds=1)),
                     event(20003, started_at=START+timedelta(days=1), finished_at=START+timedelta(days=1,seconds=1))]
            # Insert mappings independently so optional identity fields survive.
            for offset in range(0,len(rows),500):
                for row in rows[offset:offset+500]:
                    await connection.execute(insert(ApiUsageAttemptEvent), row)
        async with AsyncSession(engine) as db:
            result = await _window_attempt_coverage(db,user_id=17,provider='deepseek',
                start_utc=START,end_utc=START+timedelta(days=1))
        assert result['processed_event_rows'] == 10005
        assert result['persisted_read_state'] == 'complete' and not result['truncated']
        assert result['invocation_coverage_state'] == 'unknown' and result['invoice_total_usd'] is None
        assert result['summary']['attempts'] == 10005
        assert result['summary']['duplicate_attempts'] == 1
        assert result['summary']['known_token_estimate_attempts'] == 10002
        assert result['summary']['known_token_estimate_subtotal_usd'] == pytest.approx(10002*.000014)
        assert {group['status'] for group in result['groups']} == {'success','error','cancelled'}
        cache = result['summary']['cache_fields']['cache_miss_input_tokens']
        assert cache['reported_tokens'] is None
        assert cache['inferred_tokens'] == 10004*100
        assert result['summary']['tariff_freshness'] == 'repository_snapshot_unverified'
    finally:
        await engine.dispose()


@pytest.mark.parametrize('usage', [None, {}, {'prompt_tokens':0,'completion_tokens':0},
    {'prompt_tokens':100,'completion_tokens':0},
    {'prompt_tokens':100,'completion_tokens':0,'prompt_cache_hit_tokens':20,'prompt_cache_miss_tokens':80},
    {'prompt_tokens':100,'completion_tokens':0,'prompt_cache_hit_tokens':120,'prompt_cache_miss_tokens':80}])
def test_actual_deepseek_adapter_emits_separate_versioned_evidence(monkeypatch, usage):
    from copy import deepcopy
    saved = []
    monkeypatch.setattr(metering,'_persist_attempt',lambda values:saved.append(deepcopy(values)))
    token = set_provider_usage_context(user_id=17,job_id=None)
    response = SimpleNamespace(id='synthetic-response',model='deepseek-v4-flash',usage=SimpleNamespace(**usage) if usage is not None else None,
        choices=[SimpleNamespace(finish_reason='stop',message=SimpleNamespace(content='Synthetic answer',tool_calls=None))])
    try:
        with patch('app.domains.ai_providers.deepseek.OpenAI') as client, patch('app.domains.ai_providers.deepseek.record_provider_usage_call'):
            client.return_value.chat.completions.create.return_value = response
            result = DeepSeekProvider().generate(prompt='Synthetic fixture',model='deepseek-v4-flash')
        assert result.tokens_in == (usage or {}).get('prompt_tokens', 0)
        row = next(row for row in saved if row['event_kind']=='finished')
        contract = row['inferred_usage']['accounting_provenance']
        assert contract == tariff_provenance(RATES)
        assert contract['rate_version'].startswith('repository-sha256-')
        assert contract['settled_billed_cost_usd'] is None and contract['effective_date'] is None
        cache = row['inferred_usage']['cache_fields']
        reported = row.get('reported_usage') or {}
        assert cache['cache_read_input_tokens']['reported'] == reported.get('cache_read_input_tokens')
        if usage and usage.get('prompt_cache_hit_tokens') == 120:
            assert row['tariff_estimated_cost_usd'] is None
        if usage and usage.get('prompt_tokens') == 100 and 'prompt_cache_hit_tokens' not in usage:
            assert cache['cache_read_input_tokens']['reported'] is None
            assert cache['cache_read_input_tokens']['inferred'] == 0
            assert cache['cache_miss_input_tokens']['inferred'] == 100
    finally:
        reset_provider_usage_context(token)


@pytest.mark.asyncio
async def test_event_time_window_includes_cross_midnight_failures_and_preserves_start_gap():
    engine = create_async_engine('sqlite+aiosqlite://')
    try:
        async with engine.begin() as connection:
            await connection.run_sync(ApiUsageAttemptEvent.__table__.create)
            await connection.execute(insert(ApiUsageAttemptEvent), event(1,
                started_at=START-timedelta(minutes=1), finished_at=START+timedelta(minutes=1),
                status='cancelled',reported_usage=None,inferred_usage=None,tariff_estimated_cost_usd=None))
            await connection.execute(insert(ApiUsageAttemptEvent), event(2,event_kind='started',
                started_at=START+timedelta(hours=23),finished_at=None,status='started',
                reported_usage=None,inferred_usage=None,tariff_estimated_cost_usd=None))
            # Finish belongs to the next IST-selected UTC window; do not fetch
            # future lifecycle events or fabricate a complete pair.
            await connection.execute(insert(ApiUsageAttemptEvent), event(3,attempt_id='attempt-2',
                started_at=START+timedelta(hours=23),finished_at=START+timedelta(days=1,minutes=1)))
        async with AsyncSession(engine) as db:
            result = await _window_attempt_coverage(db,user_id=17,provider='deepseek',
                start_utc=START,end_utc=START+timedelta(days=1))
        assert result['processed_event_rows'] == 2
        assert result['summary']['finished_without_start'] == 1
        assert result['summary']['unmatched_starts'] == 1
        assert result['summary']['known_token_estimate_subtotal_usd'] is None
        assert result['persisted_read_state'] == 'complete'
        assert result['invocation_coverage_state'] == 'unknown'
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_stream_failure_never_returns_complete_or_zero_accounting():
    class BrokenStream:
        closed = False
        async def __aiter__(self):
            yield event(1)
            raise RuntimeError('Synthetic interrupted read')
        async def close(self):
            self.closed = True
    stream = BrokenStream()
    class DB:
        async def stream_scalars(self, statement):
            return stream
    with pytest.raises(RuntimeError, match='Synthetic interrupted read'):
        await _window_attempt_coverage(DB(),user_id=17,start_utc=START,end_utc=START+timedelta(days=1))
    assert stream.closed
