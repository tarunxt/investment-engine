"""Instrument actual persisted synthetic SQLite reads; no services or wire claims."""
from datetime import UTC, datetime, timedelta
import json
import tracemalloc

import pytest
from sqlalchemy import insert
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

import app.models
from app.domains.api_usage.corrected_router import _load_chart_rows, _load_effective_usage_rows
from app.domains.api_usage.router import _usage_day_string
from app.domains.api_usage.models import LlmProviderUsageCallRecord, LlmProviderUsageDailySnapshot
from app.domains.bullpen_run_audit.models import BullpenRunAuditFeedbackRecord, BullpenRunAuditFeedbackSubcallRecord
from app.domains.jobs.models import Job
from app.domains.runs.models import Run, RunJob

PROVIDERS = ('openai','anthropic','gemini','deepseek')
START = datetime(2026,10,30,tzinfo=UTC)


class InstrumentedSession(AsyncSession):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.statements = 0
        self.selected_value_json_bytes = 0
        self.hydrated_jobs = 0
        self.raw_columns = set()

    async def execute(self, statement, *args, **kwargs):
        result = await super().execute(statement,*args,**kwargs)
        frozen = result.freeze()
        rows = frozen().all()
        self.statements += 1
        values = []
        for row in rows:
            cells = []
            for value in row:
                if isinstance(value,Job):
                    self.hydrated_jobs += 1
                    columns = {key:item for key,item in vars(value).items() if key != '_sa_instance_state'}
                    self.raw_columns.update({'prompt','response'} & columns.keys())
                    cells.append(columns)
                else:
                    cells.append(value)
            values.append(cells)
        self.selected_value_json_bytes += len(json.dumps(values,default=str).encode())
        return frozen()


@pytest.mark.asyncio
@pytest.mark.parametrize('size',[1,10,1000])
async def test_persisted_four_provider_projection_comparison(size):
    engine = create_async_engine('sqlite+aiosqlite://')
    try:
        async with engine.begin() as connection:
            for model in (Job,Run,RunJob,BullpenRunAuditFeedbackRecord,
                BullpenRunAuditFeedbackSubcallRecord,LlmProviderUsageCallRecord,LlmProviderUsageDailySnapshot):
                await connection.run_sync(model.__table__.create)
            for provider in PROVIDERS:
                await connection.execute(insert(Job), [dict(user_id=17,provider=provider,model='synthetic',
                    prompt='Synthetic prompt '+('p'*256),response='Synthetic output '+('o'*4096),
                    status='failed' if index%2 else 'completed',created_at=START+timedelta(hours=index%24),updated_at=START,
                    tokens_in=100,tokens_out=10,estimated_cost=.125,
                    runtime_metadata_json={'llm_batches':[{'attempts':2}]},web_search_queries=[])
                    for index in range(size)])
            await connection.execute(insert(Job),dict(user_id=18,provider='deepseek',model='other-owner',
                prompt='Synthetic other owner',status='completed',created_at=START,updated_at=START,tokens_in=999,estimated_cost=999))
        totals = {}
        daily = {}
        measurements = {}
        for mode in ('baseline','compact'):
            tracemalloc.start()
            async with InstrumentedSession(engine) as db:
                totals[mode] = {}
                daily[mode] = {}
                for provider in PROVIDERS:
                    if mode == 'baseline':
                        rows = await _load_effective_usage_rows(db,user_id=17,start_utc=START,end_utc=START+timedelta(days=2))
                        rows = [row for row in rows if row['provider']==provider]
                    else:
                        rows = await _load_chart_rows(db,user_id=17,provider=provider,start_utc=START,end_utc=START+timedelta(days=2))
                    daily[mode][provider] = {}
                    for row in rows:
                        bucket = daily[mode][provider].setdefault(_usage_day_string(row['occurred_at']),
                            dict(requests=0,tokens_in=0,tokens_out=0,estimated_cost=0))
                        for key in bucket:
                            bucket[key] += row[key]
                    totals[mode][provider] = {key:sum(row[key] for row in rows) for key in ('requests','tokens_in','tokens_out','estimated_cost')}
                _, peak = tracemalloc.get_traced_memory()
                measurements[mode] = dict(daily_totals_json_bytes=len(json.dumps(daily[mode],sort_keys=True)),statements=db.statements,selected_value_json_bytes=db.selected_value_json_bytes,
                    hydrated_jobs=db.hydrated_jobs,raw_columns=sorted(db.raw_columns),instrumented_peak_bytes=peak)
            tracemalloc.stop()
        assert totals['baseline'] == totals['compact']
        assert daily['baseline'] == daily['compact']
        assert all(item['estimated_cost'] == size*.125 and item['requests']==size*2 for item in totals['compact'].values())
        assert measurements['baseline']['statements'] == measurements['compact']['statements'] == 16
        assert measurements['baseline']['hydrated_jobs'] == 16*size
        assert measurements['baseline']['raw_columns'] == ['prompt','response']
        assert measurements['compact']['hydrated_jobs'] == 0
        assert measurements['compact']['raw_columns'] == []
        assert measurements['compact']['selected_value_json_bytes'] < measurements['baseline']['selected_value_json_bytes']
        print(json.dumps({'rows_per_provider':size,**measurements}))
    finally:
        await engine.dispose()
