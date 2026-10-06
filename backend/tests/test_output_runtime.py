"""Offline integration of current declared output contracts; no paid requests."""
import json
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.domains.jobs import tasks
from app.domains.jobs.output_runtime import (
    active_contract_hash, configure_output_context, current_output_context,
    declares_output_contract, holdings_from_prompt, merge_swing_fragments,
    normalize_runtime_output, reset_output_context,
)
from app.domains.jobs.output_contracts import REBALANCE_COLUMNS, SWING_COLUMNS, normalize_output
from app.domains.ai_providers.base import AIProviderResponse
from app.shared.types import JobStatus
from test_output_contracts import swing_row, rebalance_row, holding, table
from test_job_table_validation import FakeDB, FakeRepo


def make_job(kind='swing', market='india', **extra):
    columns = SWING_COLUMNS if kind == 'swing' else REBALANCE_COLUMNS
    prefix = ('India swing-trade study' if market == 'india' else 'US swing-trade study') if kind == 'swing' else f'[REBALANCE_FLOW:{market}]'
    prompt = prefix + '\n\nReturn only one markdown table.\nChoose exactly 5 stocks.\n' + table(columns, [])
    if kind == 'rebalance':
        prompt += '\n\n# Inputs considered at current time\n## 1. Latest Portfolio Snapshot\n| Exchange | Stock Symbol | Current Units |\n| --- | --- | --- |\n| NSE | ABC | 10 |\n\n## 2. Completed Swing Trade Runs\n'
    return SimpleNamespace(**(dict(id=99,user_id=7,prompt=prompt,provider='deepseek',model='deepseek-v4-flash',
        status=JobStatus.PENDING,response=None,error_message=None,tokens_in=None,tokens_out=None,estimated_cost=None,
        created_at=datetime(2026,10,3,tzinfo=timezone.utc),auto_rebalance_portfolio='india' if market=='india' else 'indmoney_us',
        auto_rebalance_label=f'{"India" if market=="india" else "IndMoney US"} Run #9 ({"Swing" if kind=="swing" else "Rebalance"} Scan)') | extra))


@pytest.fixture
def scoped():
    tokens=[]
    def configure(job):
        token=configure_output_context(job,{'run_id':'4'})
        tokens.append(token)
        return job
    yield configure
    for token in reversed(tokens):
        reset_output_context(token)


def test_contract_requires_declared_columns_before_nested_inputs(scoped):
    assert not declares_output_contract('Return a generic table', 'swing')
    assert not declares_output_contract('Custom report\n# Inputs considered\n'+table(SWING_COLUMNS,[]),'swing')
    scoped(make_job())
    assert active_contract_hash()
    scoped(make_job(prompt='Custom report'))
    assert current_output_context() is None


def test_swing_stage_ignores_nested_rebalance_prompt(scoped):
    job=make_job()
    job.prompt+='\n# Inputs considered\n[REBALANCE_FLOW:india]\nrecommended rebalance'
    scoped(job)
    assert tasks._requires_stock_recommendation_output(job.prompt)
    assert not tasks._is_rebalance_output(job.prompt)


def test_complete_json_is_deterministic_and_keeps_all_scores(scoped):
    scoped(make_job())
    content=json.dumps({'stocks':[swing_row(f'TEST{i}') for i in range(5)]})
    rendered, issue, rows=tasks._validate_stock_table_content(content)
    assert issue is None and len(rows)==5
    assert 'Score Rationale Cruxx' in rendered
    assert all(f'TEST{i}' in rendered for i in range(5))
    assert normalize_runtime_output(rendered).safe_to_replace


def test_unknown_score_is_not_invented_or_dropped(scoped):
    scoped(make_job())
    rows=[swing_row(f'TEST{i}') for i in range(5)]
    rows[3]['score_rationale_cruxx']=None
    content=json.dumps(rows)
    preserved, issue, valid=tasks._validate_stock_table_content(content)
    assert preserved==content and issue.startswith('invalid output contract')
    assert len(valid)==4


def test_top_up_preserves_fragments_and_detects_duplicate_delivery(scoped):
    scoped(make_job())
    original=json.dumps([swing_row(f'TEST{i}') for i in range(4)])
    merged=merge_swing_fragments(original,json.dumps([swing_row('TEST4')]))
    result=normalize_runtime_output(merged)
    assert result.safe_to_replace and len(result.rows)==5
    duplicate=merge_swing_fragments(original,json.dumps([swing_row('TEST0')]))
    invalid=normalize_runtime_output(duplicate)
    assert not invalid.safe_to_replace and len(invalid.rows)==5
    assert any(f.code=='duplicate_stock_identity' for f in invalid.findings)


def test_extra_rows_are_preserved_and_fail_exact_count(scoped):
    scoped(make_job())
    original=json.dumps([swing_row(f'TEST{i}') for i in range(6)])
    content, issue, rows=tasks._validate_stock_table_content(original)
    assert content==original and len(rows)==6 and issue


def test_rebalance_snapshot_is_required_and_exact(scoped):
    job=make_job('rebalance')
    assert holdings_from_prompt(job.prompt)==({'exchange_symbol':'NSE','stock_symbol':'ABC','current_units':'10'},)
    scoped(job)
    rendered,issue,_=tasks._validate_rebalance_table_content(json.dumps([rebalance_row()]),job.prompt)
    assert issue is None and 'Current Units' in rendered
    with pytest.raises(ValueError, match='snapshot'):
        configure_output_context(make_job('rebalance',prompt=job.prompt.split('# Inputs')[0]),{})


def test_us_snapshot_market_identity_matches_known_us_venue_without_changing_it():
    result=normalize_output(json.dumps([rebalance_row(exchange_symbol='NASDAQ')]),'rebalance',holdings=[holding(exchange='US')])
    assert result.safe_to_replace, result.findings
    assert result.rows[0].values['exchange_symbol']=='NASDAQ'
    assert result.coverage.covered_holdings==1
    wrong=normalize_output(json.dumps([rebalance_row(exchange_symbol='NSE')]),'rebalance',holdings=[holding(exchange='US')])
    assert not wrong.safe_to_replace
    ambiguous=normalize_output(json.dumps([rebalance_row(exchange_symbol='NASDAQ')]),'rebalance',holdings=[holding(exchange='US'),holding(exchange='NYSE')])
    assert any(f.code=='ambiguous_holding' for f in ambiguous.findings)


def test_us_repair_preserves_original_budget(scoped):
    job=scoped(make_job(market='us'))
    prompt=tasks._build_stock_table_repair_prompt(job.prompt+'\nBudget USD 100','bad','invalid')
    assert 'INR 50,000' not in prompt
    assert 'Budget USD 100' in prompt


def test_deepseek_complete_json_skips_format_call(scoped):
    from app.domains.ai_providers.deepseek import DeepSeekProvider
    job=scoped(make_job())
    response=SimpleNamespace(usage=SimpleNamespace(prompt_tokens=20,completion_tokens=30),choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps([swing_row(f'TEST{i}') for i in range(5)]),tool_calls=None))])
    client=MagicMock()
    client.chat.completions.create.return_value=response
    with patch('app.domains.ai_providers.deepseek.OpenAI',return_value=client):
        result=DeepSeekProvider().generate(prompt=job.prompt,model=job.model)
    client.chat.completions.create.assert_called_once()
    assert normalize_runtime_output(result.content).safe_to_replace
    assert result.tokens_in==20 and result.tokens_out==30


def execute_mocked(job, results):
    db,repo,provider=FakeDB(),FakeRepo(job),MagicMock()
    provider.generate.side_effect=results
    with patch.object(tasks,'SyncSessionLocal',return_value=db),patch.object(tasks,'SyncJobRepository',return_value=repo),patch('app.domains.ai_providers.factory.ProviderFactory.create',return_value=provider) as factory,patch.object(tasks,'_publish_job_update'),patch.object(tasks,'_refresh_run_status'),patch.object(tasks,'_mark_failed') as failed:
        tasks.execute_ai_job.run(job.id)
    return db,provider,factory,failed


def test_worker_formats_complete_output_once_and_resets_context():
    job=make_job()
    result=AIProviderResponse(content=json.dumps([swing_row(f'TEST{i}') for i in range(5)]),tokens_in=1,tokens_out=2,cost=.001,provider=job.provider,model=job.model)
    db,provider,_,failed=execute_mocked(job,[result])
    assert job.status==JobStatus.COMPLETED and db.closed
    provider.generate.assert_called_once()
    failed.assert_not_called()
    assert current_output_context() is None
    assert 'Score Rationale Cruxx' in job.response


def test_preflight_missing_snapshot_never_creates_provider_and_resets_context():
    job=make_job('rebalance')
    job.prompt=job.prompt.split('# Inputs')[0]
    db,provider,factory,failed=execute_mocked(job,[])
    factory.assert_not_called()
    provider.generate.assert_not_called()
    failed.assert_called_once()
    assert db.closed and current_output_context() is None


@pytest.mark.parametrize('status',[JobStatus.COMPLETED,JobStatus.PARTIAL,JobStatus.FAILED])
def test_terminal_redelivery_does_not_regenerate(status):
    job=make_job(status=status,response='Existing result')
    db,provider,factory,failed=execute_mocked(job,[])
    assert job.response=='Existing result'
    factory.assert_not_called()
    provider.generate.assert_not_called()
    assert db.closed


def test_empty_snapshot_is_known_empty_but_bad_width_is_unknown(scoped):
    job=make_job('rebalance')
    empty=job.prompt.replace('| NSE | ABC | 10 |\n','')
    assert holdings_from_prompt(empty)==()
    bad=empty.replace('| --- | --- | --- |','| --- | --- |')
    assert holdings_from_prompt(bad) is None
    scoped(make_job('rebalance',prompt=empty))
    new=rebalance_row(current_units=0,action='Buy New',units_change=2,final_units=2,units_to_buy=2,total_buy_amount=200)
    assert normalize_runtime_output(json.dumps([new])).safe_to_replace


def test_failed_contract_has_observed_coverage_and_no_whole_job_retry(scoped):
    from app.domains.jobs.output_runtime import output_validation_metadata
    scoped(make_job())
    content=json.dumps([swing_row(f'TEST{i}') for i in range(4)])
    metadata=output_validation_metadata(content)
    assert metadata['coverage']['canonical_rows']==4
    assert metadata['safe_to_render'] is False
    assert metadata['semantic_research_quality']=='not_evaluated'
    assert tasks._classify_exc(RuntimeError('p/m returned invalid output contract (missing field)'))==(False,0)


def test_custom_extra_duplicate_or_reordered_schema_does_not_opt_in():
    header='| '+' | '.join(column.label for column in SWING_COLUMNS)+' |'
    assert declares_output_contract(header,'swing')
    assert not declares_output_contract(header+' Custom Mandatory Metric |','swing')
    assert not declares_output_contract(header+' Stock Symbol |','swing')
    assert not declares_output_contract('| '+' | '.join(column.label for column in reversed(SWING_COLUMNS))+' |','swing')


def test_cancellation_during_last_repair_stays_cancelled():
    job=make_job()
    calls=[]
    def generate(**kwargs):
        calls.append(kwargs)
        if len(calls)==3:
            job.status=JobStatus.FAILED
            job.error_message='Cancelled by user'
        content=json.dumps([swing_row(f'TEST{i}') for i in range(4)]) if len(calls)==1 else ''
        return AIProviderResponse(content=content,tokens_in=1,tokens_out=2,cost=.001,provider=job.provider,model=job.model)
    _,provider,_,failed=execute_mocked(job,generate)
    assert provider.generate.call_count==3
    assert job.status==JobStatus.FAILED and job.error_message=='Cancelled by user'
    failed.assert_not_called()
    assert current_output_context() is None


def test_cancellation_during_provider_error_does_not_retry_or_overwrite():
    job=make_job()
    def generate(**kwargs):
        job.status=JobStatus.FAILED
        job.error_message='Cancelled by user'
        raise RuntimeError('Transient provider failure')
    _,provider,_,failed=execute_mocked(job,generate)
    provider.generate.assert_called_once()
    failed.assert_not_called()
    assert job.error_message=='Cancelled by user' and current_output_context() is None


def test_failed_cancellation_read_preserves_original_failure(monkeypatch):
    job=make_job()
    generation_failed=False
    def get_fresh(repo,job_id):
        if generation_failed:
            raise RuntimeError('Secondary state read failure')
        return repo.get(job_id)
    def generate(**kwargs):
        nonlocal generation_failed
        generation_failed=True
        raise RuntimeError('p/m returned invalid output contract (synthetic)')
    monkeypatch.setattr(FakeRepo,'get_fresh',get_fresh,raising=False)
    _,_,_,failed=execute_mocked(job,generate)
    failed.assert_called_once()
    assert failed.call_args.args[3]=='p/m returned invalid output contract (synthetic)'
    assert current_output_context() is None
