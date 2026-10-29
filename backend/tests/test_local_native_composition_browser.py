"""Opt-in loopback UI qualification of installed composition; SQLite/fake delivery.

No auth/runtime dependency overrides. Native hosted startup remains unchanged.
No preview routes are mounted. This fixture is not hosted/native-main acceptance.
"""
import os,time,threading,subprocess,json,asyncio
from collections import deque
from pathlib import Path
from datetime import datetime,timezone,timedelta
import pytest
from fastapi import FastAPI,APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
from test_hosted_order_composition import order_env,worker_env,linked_env

pytestmark=pytest.mark.skipif(os.getenv('CREDX_LOCAL_NATIVE_BROWSER')!='disposable-loopback-only',reason='Explicit disposable local browser runtime required')


@pytest.fixture
def outcome():
    value=os.getenv('LOCAL_NATIVE_BROWSER_ORDER_OUTCOME','filled')
    assert value in {'filled','partial','before_acceptance'}
    assert value=='filled' or os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')=='concept-f-safety'
    return value

@pytest.mark.parametrize('worker_env',['journal'],indirect=True)
def test_installed_composition_ui_with_actual_login_and_no_dependency_overrides(order_env,monkeypatch,tmp_path,outcome):
    import uvicorn
    import app.infrastructure.database.session as sessions
    from app.domains.auth.router import router as auth
    from app.domains.modules.router import router as modules
    from app.domains.connections.router import router as connections
    from app.domains.auth.models import User,UserProfile,ActivityLog,UserSession,APIKey
    from app.core.security import PasswordUtils
    from app.domains.modules.transports import install_route_policy
    from app.shared.exceptions import AppException
    from app.uat2.workflow import install_workflow
    e,analysis,worker,factory,celery,deliveries,clock,flow,intent=order_env
    root=Path(__file__).resolve().parents[2]
    from scripts.public_launch.concept_f_build_receipt import verified_build
    build=(root/'frontend'/os.environ['LOCAL_NATIVE_NEXT_DIR']).resolve()
    assert build.parent==(root/'frontend').resolve()
    build_binding=verified_build(build,root/'backend/app')
    node=os.environ['LOCAL_NATIVE_NODE'];sha=build_binding['source_sha']
    monkeypatch.setenv('CREDX_UAT2','0')
    monkeypatch.setenv('JWT_SIGNING_KEY','local-native-browser-synthetic-'+('x'*40))
    from app.infrastructure.database.base import Base
    Base.metadata.create_all(e.engine)
    for subject in (1,2):e.db.get(User,subject).password_hash=PasswordUtils.hash_password('SyntheticPreview123!')
    if os.getenv('LOCAL_NATIVE_BROWSER_CAPTURE_ONLY')=='source-bound-read-only' or os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')in {'concept-f-zero','concept-f-onboarding','concept-f-activity'}:
        # A real zero-selection synthetic owner, not an empty-source owner with
        # modules still enabled. No production account or runtime override.
        from sqlalchemy import select
        from app.domains.modules.models import UserModule,UserModulePreferences
        header=e.db.get(UserModulePreferences,2);assert header is not None
        header.version+=1
        for selection in e.db.scalars(select(UserModule).where(UserModule.user_id==2)):
            selection.enabled=False;selection.version=header.version;selection.schedules_paused=True

    if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')in {'concept-f-legacy-table','concept-f-legacy-formula','concept-f-long-text'}:
        from app.domains.jobs.models import Job
        from app.shared.types import JobStatus
        for subject,symbol,sequence,portfolio in ([(1,'LEGACY0',91,'india'),(2,'FOREIGN0',92,'india')]+([(1,'USLEGACY0',191,'indmoney_us'),(2,'USFOREIGN0',192,'indmoney_us')] if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')=='concept-f-legacy-table' else [])):
            long_text=('FIRST_SAVED_RATIONALE '+('A'*16000)+'<script>globalThis.__conceptFLongTextExecuted=true</script>'+('B'*16000)+' LAST_SAVED_RATIONALE') if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')=='concept-f-long-text' else None
            e.db.add(Job(user_id=subject,module_id='zerodha_rebalance' if portfolio=='india' else 'indmoney_us',module_version=1,
                provider='fake',model='historical-fixture',status=JobStatus.COMPLETED,
                prompt=('[REBALANCE_FLOW:india]\n' if portfolio=='india' else '[REBALANCE_FLOW:us]\n')+(long_text or 'Rebalance scan synthetic saved source'),
                response=json.dumps({'stocks':[{'Exchange Symbol':'NSE' if portfolio=='india' else 'NASDAQ','Stock Symbol':symbol,
                    'Current Units':0,'Action (Buy/Add/Sell All/Trim/Hold/Buy New)':'Hold',
                    'Final Units':0,'Rationale Cruxx':long_text or 'Synthetic saved rationale only',
                    'Score Rationale Cruxx':0,'Confidence Score (0-100)':0,
                    **({'Rationale Technical Setup Short Term 1–3 Months':'Saved short-term source only','Score Rationale Technical Setup Short Term 1–3 Months':68,
                        'Rationale - Technical Setup (Medium Term)':'Saved medium-term source only','Score Rationale - Technical Setup (Medium Term)':70,
                        'Rationale - Technical Setup (Long Term)':'Saved longer-term source only','Score Rationale - Technical Setup (Long Term)':74,
                        'Rationale - Fundamentals Short Term':'Saved fundamentals short-term only','Score Rationale - Fundamentals Short Term':63,
                        'Rationale - Fundamentals Medium/Long Term':'Saved fundamentals long-term only','Score Rationale - Fundamentals Medium/Long Term':'',
                        'Entry Range':'Synthetic entry range unavailable','Stop Loss':'Synthetic stop unavailable','Target':'Synthetic target unavailable','Analyst/Source':'Historical fixture, no live provider'}
                       if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')=='concept-f-legacy-table' else {})}]}),
                auto_rebalance_portfolio=portfolio,auto_rebalance_sequence=sequence,
                auto_rebalance_label=f"{'India' if portfolio=='india' else 'US'} Run #{sequence} (Rebalance Scan)"))
    if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')=='concept-f-cost-history':
        # Persist synthetic login setup before authority's populate_existing read.
        # This fixture session deliberately has autoflush=False.
        e.db.commit()
        # A second actual durable fake workflow, not copied completed receipts.
        from app.domains.runs.analysis_workflows.service import Workflows
        from app.domains.runs.models import AutoRebalanceWorkflow
        from app.uat2.analysis_worker import STAGE,JOB
        second=Workflows(e.db,analysis.analysis.runtime).create(1,'india','cost-history-second-owned-flow',now=clock[0]);e.db.commit()
        second_id=second.id
        for _ in range(40):
            analysis.relay();batch=list(deliveries);deliveries.clear()
            for kind,args in batch:
                if kind==STAGE:analysis.stage(*args)
                elif kind==JOB:analysis.job(*args)
                else:raise AssertionError('Cost-history seed admits only actual fake analysis tasks')
            with factory() as db:
                if db.get(AutoRebalanceWorkflow,second_id).status=='completed':break
            clock[0]+=timedelta(seconds=6)
        with factory() as db:
            assert db.get(AutoRebalanceWorkflow,second_id).status=='completed'
            assert all(PasswordUtils.verify_password('SyntheticPreview123!',db.get(User,subject).password_hash) for subject in (1,2))
        from decimal import Decimal
        from app.domains.fx_rates.models import FxRate
        fx_case=os.getenv('LOCAL_NATIVE_COST_FX_CASE','valid');assert fx_case in {'valid','stale'}
        FxRate.__table__.create(e.engine,checkfirst=True)
        fx_now=datetime.now(timezone.utc)
        e.db.add(FxRate(base_currency='USD',quote_currency='INR',rate=Decimal('83.25'),source='synthetic-cost-fx',source_as_of=fx_now-timedelta(hours=1 if fx_case=='valid' else 48),fetched_at=fx_now,verified=True));e.db.commit()
        # Saved prior-attempt diagnostic fixture; current completed job/workflow outcome is not rewritten.
        from sqlalchemy import select
        from app.domains.jobs.models import Job
        from app.domains.runs.models import AutoRebalanceWorkflowStage
        diagnostic_id=e.db.scalar(select(AutoRebalanceWorkflowStage.job_id).where(AutoRebalanceWorkflowStage.workflow_id==flow,AutoRebalanceWorkflowStage.stage=='rebalance'))
        diagnostic_job=e.db.get(Job,diagnostic_id);assert diagnostic_job is not None and diagnostic_job.user_id==1
        diagnostic_job.runtime_metadata_json={**(diagnostic_job.runtime_metadata_json or {}),'failure_diagnostics':{'job_id':diagnostic_job.id,'run_id':None,'provider':diagnostic_job.provider,'model':diagnostic_job.model,'http_status':503,'retry_safe':False,'correlation_id':'synthetic-prior-attempt','attempt':1,'exception_type':'SyntheticPriorFailure','trace_reference':'synthetic-prior-job:'+str(diagnostic_job.id),'provider_response_body':'api_key=SYNTHETIC_PRIVATE_GOVERNED_DIAGNOSTIC'}}
        e.db.commit();monkeypatch.setenv('LOCAL_NATIVE_DIAGNOSTIC_JOB_ID',str(diagnostic_id))
        monkeypatch.setenv('LOCAL_NATIVE_COST_FLOW_ID',str(flow));monkeypatch.setenv('LOCAL_NATIVE_COST_SECOND_FLOW_ID',str(second_id))
    if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')=='concept-f-legacy-costs':
        from app.domains.jobs.models import Job
        from app.shared.types import JobStatus
        for subject in (1,2):
            for portfolio,module in (('india','zerodha_rebalance'),('indmoney_us','indmoney_us')):
                for index,cost in ((1,0),(2,None),(3,0.000000001)):
                    diagnostic_job=Job(user_id=subject,module_id=module,module_version=1,provider='fake',
                        model=('owned-cost-' if subject==1 else 'FOREIGN_COST_')+str(index),status=JobStatus.COMPLETED,
                        prompt='Synthetic saved cost receipt only',response='Synthetic saved result; no provider activity',
                        estimated_cost=cost,tokens_in=0 if index==1 else None,tokens_out=123 if index==1 else None,web_search_used=False if index==1 else None,runtime_metadata_json={'api_key':'SYNTHETIC_PRIVATE_COST_METADATA','duration_ms':999} if index==1 else None,auto_rebalance_portfolio=portfolio,auto_rebalance_sequence=198,
                        created_at=e.now-timedelta(seconds=5) if index==1 else e.now,updated_at=e.now)
                    e.db.add(diagnostic_job);e.db.flush()
                    if index==3:
                        diagnostic_job.status=JobStatus.FAILED
                        diagnostic_job.error_message="Synthetic saved provider unavailable"
                        diagnostic_job.runtime_metadata_json={"failure_diagnostics":{"job_id":diagnostic_job.id,"run_id":None,"provider":"fake","model":diagnostic_job.model,"http_status":503,"retry_safe":False,"correlation_id":"synthetic-diagnostic-correlation","attempt":2,"exception_type":"SyntheticProviderUnavailable","trace_reference":"synthetic-job:"+str(diagnostic_job.id),"provider_response_body":"api_key=SYNTHETIC_PRIVATE_DIAGNOSTIC"}}
    if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')=='concept-f-legacy-formula':
        from app.domains.runs.models import Run,RunJob
        from app.domains.jobs.models import Job
        from app.shared.types import JobStatus
        for subject,symbol in ((1,'FORMULA0'),(2,'FOREIGN0')):
            prompt='[REBALANCE_FLOW:india]\nRebalance scan synthetic saved source'
            run=Run(user_id=subject,module_id='zerodha_rebalance',module_version=1,prompt=prompt,
                prompt_preview=prompt,status=JobStatus.COMPLETED,auto_export_enabled=False,
                auto_rebalance_portfolio='india',auto_rebalance_sequence=93,
                auto_rebalance_label='India Run #93 (Rebalance Scan)')
            job=Job(user_id=subject,module_id='zerodha_rebalance',module_version=1,provider='fake',
                model='formula-fixture',status=JobStatus.COMPLETED,prompt=prompt,
                auto_rebalance_portfolio='india',auto_rebalance_sequence=93,
                response=json.dumps({'stocks':[{'Exchange Symbol':'NSE','Stock Symbol':symbol,
                    'Current Units':0,'Action (Buy/Add/Sell All/Trim/Hold/Buy New)':'Hold',
                    'Final Units':0,'Rationale Cruxx':'Synthetic formula rationale',
                    'Score Rationale Cruxx':0,'Confidence Score (0-100)':0}]}))
            e.db.add_all([run,job]);e.db.flush();e.db.add(RunJob(run_id=run.id,job_id=job.id,stage=1))
            if subject==2:monkeypatch.setenv('LOCAL_NATIVE_CLASSIC_FOREIGN_RUN_ID',str(run.id))
    if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')=='concept-f-legacy-formula':
        from app.domains.runs.models import Run,RunJob
        from app.domains.jobs.models import Job
        from app.shared.types import JobStatus
        for portfolio,module in (('india','zerodha_rebalance'),('indmoney_us','indmoney_us')):
            for subject in (1,2):
                prompt='[REBALANCE_FLOW:'+portfolio+'] Rebalance scan synthetic timestamp-only source'
                timed_run=Run(user_id=subject,module_id=module,module_version=1,prompt=prompt,prompt_preview=prompt,
                    status=JobStatus.COMPLETED,auto_export_enabled=False,auto_rebalance_portfolio=portfolio,auto_rebalance_sequence=96,
                    auto_rebalance_label='Synthetic Rebalance Scan #96',created_at=e.now-timedelta(seconds=53),updated_at=e.now)
                e.db.add(timed_run);e.db.flush()
                for index,tail in ((1,7),(2,14)):
                    timed_job=Job(user_id=subject,module_id=module,module_version=1,provider='fake',model=('legacy-clock-' if subject==1 else 'FOREIGN_LEGACY_CLOCK_')+str(index),
                        status=JobStatus.COMPLETED,prompt=prompt,response='Synthetic saved timing source only',
                        auto_rebalance_portfolio=portfolio,auto_rebalance_sequence=96,
                        created_at=e.now-timedelta(seconds=49),updated_at=e.now-timedelta(seconds=tail))
                    e.db.add(timed_job);e.db.flush();e.db.add(RunJob(run_id=timed_run.id,job_id=timed_job.id,stage=1))
    if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')=='concept-f-legacy-formula':
        # Persisted multi-stage/multi-model matrix inputs; never dispatched or executed.
        from app.domains.runs.models import Run,RunJob
        from app.domains.jobs.models import Job
        from app.shared.types import JobStatus
        for portfolio,module,market,exchange in (('india','zerodha_rebalance','India','NSE'),('indmoney_us','indmoney_us','IndMoney US','NASDAQ')):
            for subject in (1,2):
                for stage in ('threats','swing','rebalance','technical'):
                    label=f'{market} Run #97 ({stage.title()} Scan)'
                    prompt=f'Synthetic {market} {stage} scan, persisted test evidence only'
                    matrix_run=Run(user_id=subject,module_id=module,module_version=1,prompt=prompt,prompt_preview=prompt,status=JobStatus.COMPLETED,auto_export_enabled=False,auto_rebalance_portfolio=portfolio,auto_rebalance_sequence=97,auto_rebalance_label=label)
                    e.db.add(matrix_run);e.db.flush()
                    if subject==2 and portfolio=='india' and stage=='rebalance':monkeypatch.setenv('LOCAL_NATIVE_MATRIX_FOREIGN_RUN_ID',str(matrix_run.id))
                    for index in range(2 if stage in ('swing','rebalance') else 1):
                        symbols=['ALPHA','BETA','GAMMA']
                        if stage=='technical' and os.getenv('LOCAL_NATIVE_BROWSER_STOCK_MATRIX_ONLY') not in ('selected-read-only','explicit-advisory-save'):symbols.remove('BETA')
                        if stage=='swing' and index==1:symbols.remove('GAMMA')
                        stocks=[{'Exchange Symbol':exchange,'Stock Symbol':symbol if subject==1 else 'FOREIGN_MATRIX_'+symbol,'Current Units':0,'Final Units':0,'Action (Buy/Add/Sell All/Trim/Hold/Buy New)':'Hold','Rationale Cruxx':'Synthetic matrix input only','Score Rationale Cruxx':0,'Confidence Score (0-100)':0} for symbol in symbols]
                        if os.getenv('LOCAL_NATIVE_BROWSER_STOCK_MATRIX_ONLY') in ('selected-read-only','explicit-advisory-save') and subject==1:
                            for stock in stocks:
                                if stock['Stock Symbol']=='BETA':
                                    stock.update({'Final Units':1,'Action (Buy/Add/Sell All/Trim/Hold/Buy New)':'Buy New','Score Rationale Cruxx':3,'Score Rationale Technical Setup Short Term 1–3 Months':3,'Score Rationale - Technical Setup (Medium Term)':3,'Score Rationale - Technical Setup (Long Term)':3,'Score Rationale - Fundamentals Short Term':3,'Score Rationale - Fundamentals Medium/Long Term':3,'Confidence Score (0-100)':10})
                        if os.getenv('LOCAL_NATIVE_BROWSER_RECOMMENDATION_HISTORY_ONLY')=='captured-workspace-read-only' and subject==1:
                            for stock in stocks:
                                if stock['Stock Symbol']=='ALPHA':stock['Total Buy Amount']='0'
                        matrix_job=Job(user_id=subject,module_id=module,module_version=1,provider='fake',model=f'matrix-{stage}-{index+1}',status=JobStatus.COMPLETED,prompt=prompt,response=json.dumps({'stocks':stocks}),auto_rebalance_portfolio=portfolio,auto_rebalance_sequence=97)
                        e.db.add(matrix_job);e.db.flush();e.db.add(RunJob(run_id=matrix_run.id,job_id=matrix_job.id,stage=1))
    if os.getenv('LOCAL_NATIVE_BROWSER_RECOMMENDATION_HISTORY_ONLY'):
        assert os.getenv('LOCAL_NATIVE_BROWSER_RECOMMENDATION_HISTORY_ONLY') in ('persisted-context-read-only','captured-workspace-read-only','calculation-sheet-read-only') and os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')=='concept-f-legacy-formula'
        from app.domains.runs.models import FinalActionableHistory,Run,RunJob
        from app.domains.jobs.models import Job
        from app.shared.types import JobStatus
        for portfolio,module,market in [('india','zerodha_rebalance','India'),('indmoney_us','indmoney_us','IndMoney US')]:
            foreign_source=None
            for subject in (1,2):
                for index in range(27):
                    status=['suggested','not_mentioned','run_failed'][index] if index<3 else 'suggested'
                    prompt='[REBALANCE_FLOW:'+('india' if portfolio=='india' else 'us')+']'
                    source=Run(user_id=subject,module_id=module,module_version=1,prompt=prompt,prompt_preview=prompt,status=JobStatus.COMPLETED,auto_export_enabled=False,auto_rebalance_portfolio=portfolio,auto_rebalance_sequence=300+index,auto_rebalance_label=f'{market} Run #{300+index} (Rebalance Scan)')
                    e.db.add(source);e.db.flush()
                    job=Job(user_id=subject,module_id=module,module_version=1,provider='fake',model='persisted-history-offline',prompt='PRIVATE_UNPROJECTED_HISTORY_JOB',response='PRIVATE_UNPROJECTED_HISTORY_RESULT',status=JobStatus.COMPLETED)
                    e.db.add(job);e.db.flush();e.db.add(RunJob(run_id=source.id,job_id=job.id));e.db.flush()
                    e.db.add(FinalActionableHistory(user_id=subject,rebalance_run_id=source.id,market='india' if portfolio=='india' else 'us',stock_symbol='ALPHA',stock_name='OWNED_A_HISTORY' if subject==1 else 'OWNED_B_HISTORY',covered_at=e.now-timedelta(days=index+1),action='Buy New' if index==0 else None,score=0 if index==0 else None,consensus_numerator=0 if index==0 else None,consensus_denominator=2 if index==0 else None,historical_current_units=0 if index==0 else None,historical_current_value=0 if index==0 else None,action_units=1 if index==0 else None,amount=0 if index==0 else None,formula_version='persisted-synthetic-v1',source_run_ids_json=[],formula_inputs_json={'PRIVATE_FORMULA':'not projected'},snapshot_json={'PRIVATE_SNAPSHOT':'not projected'},coverage_status=status))
                    if subject==2 and index==0:foreign_source=source.id
            e.db.add(Job(user_id=1,module_id=module,module_version=1,provider='fake',model='captured-unavailable',status=JobStatus.FAILED,prompt='[REBALANCE_FLOW:'+('india' if portfolio=='india' else 'us')+']\nSynthetic saved unexecuted failure',response=None,error_message='Synthetic unavailable output',auto_rebalance_portfolio=portfolio,auto_rebalance_sequence=97))
            assert foreign_source is not None
            e.db.add(FinalActionableHistory(user_id=1,rebalance_run_id=foreign_source,market='india' if portfolio=='india' else 'us',stock_symbol='ALPHA',covered_at=e.now,action='PRIVATE_FOREIGN_LINK_ACTION',formula_version='unverified-fixture',source_run_ids_json=[],coverage_status='suggested'))
    if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')=='concept-f-legacy-formula':
        from app.domains.jobs.models import Job
        from app.shared.types import JobStatus
        for subject in (1,2):
            for status in (JobStatus.COMPLETED,JobStatus.PARTIAL,JobStatus.FAILED,JobStatus.PENDING):
                e.db.add(Job(user_id=subject,module_id='zerodha_rebalance',module_version=1,
                    provider='fake',model='state-'+status.value,status=status,
                    prompt='Synthetic saved state input only',
                    response='Synthetic saved '+status.value+' response' if status in (JobStatus.COMPLETED,JobStatus.PARTIAL) else None,
                    error_message='Synthetic saved failure only' if status==JobStatus.FAILED else None,
                    auto_rebalance_portfolio='india',auto_rebalance_sequence=94))
        for subject in (1,2):
            e.db.add(Job(user_id=subject,module_id='zerodha_rebalance',module_version=1,provider='fake',model='offline',status=JobStatus.COMPLETED,prompt='[ZERODHA_EVENTS]',response='| Date | Exchange | Stock Symbol | Stock Name | Event | Why it may matter | Expected Outcome | Status / Source |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| 27 Oct 2026 | NSE | SYNTHETIC0 | Synthetic fixture | Results | Test only | Neutral | Synthetic source |\n| 27 Oct 2026 | NSE | FORMULA0 | Synthetic advisory stock | Saved update | Test only | Unknown | Synthetic source |'))
    if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')in {'concept-f-library','concept-f-legacy-formula'}:
        from app.domains.prompts.models import Prompt
        e.db.add(Prompt(user_id=None,is_system=True,name='Synthetic system library',body='System prompt fixture',is_active=True))
        e.db.add(Prompt(user_id=1,is_system=False,name='Synthetic owned library',body='PROMPT_LIBRARY_SYNTHETIC_ONLY <script>globalThis.__conceptFPromptExecuted=true</script>',is_active=True))
        e.db.add(Prompt(user_id=1,is_system=False,name='Synthetic alternate library',body='ALTERNATE_PROMPT_SYNTHETIC_ONLY',is_active=True))
        foreign=Prompt(user_id=2,is_system=False,name='Foreign library fixture',body='FOREIGN_LIBRARY_BODY',is_active=True)
        e.db.add(foreign);e.db.flush();monkeypatch.setenv('LOCAL_NATIVE_LIBRARY_FOREIGN_ID',str(foreign.id))
    if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')=='concept-f-threats':
        from app.domains.jobs.models import Job
        from app.shared.types import JobStatus
        for subject in (1,2):
            for market,module,marker in [('india','zerodha_rebalance','[ZERODHA_THREATS]'),('indmoney_us','indmoney_us','[INDMONEY_US_THREATS]')]:
                body='## Summary\n- Main portfolio risk in one sentence: Synthetic concentration only\n\n## Table 3: Stock-Level Threat Map\n| Stock Symbol | Threat | Severity |\n| --- | --- | --- |\n| SYNTHETIC0 | Synthetic source risk | High |\n'
                row=Job(user_id=subject,module_id=module,module_version=1,provider='fake',model='offline',status=JobStatus.COMPLETED,prompt=marker,response=body,auto_rebalance_portfolio=market)
                e.db.add(row);e.db.flush()
                if subject==2:monkeypatch.setenv('LOCAL_NATIVE_THREAT_FOREIGN_'+market.upper(),str(row.id))
    if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')=='concept-f-activity':
        from app.domains.runs.models import Run
        from app.shared.types import JobStatus
        for subject,market,module,sequence in ((1,'india','zerodha_rebalance',91),(1,'indmoney_us','indmoney_us',92),(2,'indmoney_us','indmoney_us',93)):
            e.db.add(Run(user_id=subject,module_id=module,module_version=1,prompt='ACTIVITY_PRIVATE_SYNTHETIC_BODY',prompt_preview='ACTIVITY_PRIVATE_SYNTHETIC_PREVIEW',status=JobStatus.COMPLETED,auto_export_enabled=False,auto_rebalance_portfolio=market,auto_rebalance_sequence=sequence))
        from app.domains.jobs.models import Job
        e.db.add(Job(user_id=1,module_id='indmoney_us',module_version=1,provider='fake',model='recorded-zero-estimate',status=JobStatus.COMPLETED,prompt='[REBALANCE_FLOW:indmoney_us]\nTechnical scan synthetic source',response='Synthetic saved output',estimated_cost=0,auto_rebalance_portfolio='indmoney_us',auto_rebalance_sequence=92,auto_rebalance_label='US Run #92 (Technical Scan)'))
        from app.domains.indmoney_us.import_validation import parse_import
        from app.domains.indmoney_us.schemas import IndMoneyUsPortfolioSnapshotCreateRequest
        from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot
        raw='symbol,company_name,currency,quantity,market_price,invested_value,current_value,total_pnl,total_pnl_percent\nSYNUSA,Synthetic Activity Alpha,USD,2,55,100,110,10,10\nSYNUSB,Synthetic Activity Beta,USD,1,25,20,25,5,25\n'
        for subject,days in ((1,2),(1,0),(2,1)):
            captured=datetime.now(timezone.utc)-timedelta(days=days)
            data=parse_import(IndMoneyUsPortfolioSnapshotCreateRequest(raw_text=raw,captured_at=captured,format='csv'))
            assert not data['import_provenance']['errors']
            data['acceptance_state']='accepted';data['accepted_at']=captured
            snapshot=IndMoneyUsPortfolioSnapshot(user_id=subject,**data);e.db.add(snapshot);e.db.flush()
            if subject==2:monkeypatch.setenv('LOCAL_NATIVE_ACTIVITY_FOREIGN_SNAPSHOT',str(snapshot.id))
        from app.domains.runs.models import AutoRebalanceWorkflow
        for sequence,status in ((94,'paused'),(95,'partial'),(96,'failed')):
            e.db.add(AutoRebalanceWorkflow(user_id=1,module_id='zerodha_rebalance',portfolio='india',sequence=sequence,label='Synthetic saved '+status,status=status,current_stage='technical',control_version=3))
        e.db.add(Run(user_id=1,module_id='zerodha_rebalance',module_version=1,prompt='Synthetic completed child',prompt_preview='Synthetic completed child',status=JobStatus.COMPLETED,auto_export_enabled=False,auto_rebalance_portfolio='india',auto_rebalance_sequence=94))
    if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')=='concept-f-model-selection':
        from app.domains.jobs.models import Job
        from app.shared.types import JobStatus
        foreign_job=Job(user_id=2,module_id='zerodha_rebalance',module_version=1,provider='fake',model='offline',status=JobStatus.COMPLETED,prompt='FOREIGN_MODEL_JOB_SYNTHETIC_ONLY',response='FOREIGN_MODEL_OUTPUT_SYNTHETIC_ONLY')
        e.db.add(foreign_job);e.db.flush()
        monkeypatch.setenv('LOCAL_NATIVE_MODEL_FOREIGN_JOB_ID',str(foreign_job.id))
    if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')in {'concept-f-profile','concept-f-model-selection','concept-f-legacy-formula','concept-f-legacy-table','concept-f-plans','concept-f-utilities','concept-f-cost-history','concept-f-legacy-costs','concept-f-us-research','concept-f-journal'}:
        for subject,zone in ((1,'UTC'),(2,'Asia/Kolkata')):
            profile=e.db.get(UserProfile,subject)
            if profile is None:
                profile=UserProfile(user_id=subject);e.db.add(profile)
            profile.timezone=zone
            if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')in {'concept-f-legacy-costs','concept-f-us-research'}:profile.theme_preference='light'
    if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')=='concept-f-legacy-formula':
        from copy import deepcopy
        from app.domains.runs.models import AutoRebalanceWorkflow,AutoRebalanceWorkflowStage
        from app.domains.runs.analysis_workflows.contracts import STAGES
        original=e.db.get(AutoRebalanceWorkflow,flow)
        failed=AutoRebalanceWorkflow(user_id=1,module_id=original.module_id,module_version=original.module_version,
            portfolio='india',sequence=95,label='Synthetic saved timing failure',status='failed',current_stage='swing',
            error_message='Synthetic saved provider unavailable',orchestration_kind='analysis_v1',
            request_key='synthetic-timing-error-fixture',execution_json=deepcopy(original.execution_json),control_version=1)
        e.db.add(failed);e.db.flush()
        from app.domains.jobs.models import Job
        from app.shared.types import JobStatus
        timing_job=Job(user_id=1,module_id=original.module_id,module_version=original.module_version,
            provider='fake',model='offline',status=JobStatus.FAILED,prompt='Synthetic saved timing context only',
            error_message='api_key=SYNTHETIC_PRIVATE_TIMING_ERROR',created_at=e.now-timedelta(seconds=38),updated_at=e.now-timedelta(seconds=7))
        e.db.add(timing_job);e.db.flush()
        for name in STAGES:
            error='Synthetic saved provider unavailable' if name=='swing' else 'api_key=SYNTHETIC_PRIVATE_TIMING_ERROR' if name=='technical' else None
            e.db.add(AutoRebalanceWorkflowStage(workflow_id=failed.id,stage=name,status='failed' if error else 'skipped',
                error_message=error,job_id=timing_job.id if name=='technical' else None,attempt_count=1 if error else 0,checkpoint_json={'attempts':[],'job_history':[]},
                started_at=e.now-timedelta(seconds=42) if error else None,completed_at=e.now if error else None))
        monkeypatch.setenv('LOCAL_NATIVE_TIMING_FAILED_WORKFLOW_ID',str(failed.id))
        # A historical, self-consistent prompt plan; no job/output/outbox is created for it.
        from app.domains.runs.analysis_workflows.contracts import digest
        execution=deepcopy(original.execution_json)
        execution['plan']['version']='synthetic-historical-plan-2'
        execution['plan']['stages']['rebalance']['prompt_version']='synthetic-long-prompt-2'
        execution['plan']['stages']['rebalance']['template']='PROMPT_LONG_START '+('synthetic frozen context '.strip()+' ')*1600+' PROMPT_LONG_END <script>globalThis.__conceptFStagePromptExecuted=true</script>'
        execution['plan_hash']=digest(execution['plan'])
        prompt_record=AutoRebalanceWorkflow(user_id=1,module_id=original.module_id,module_version=original.module_version,
            portfolio='india',sequence=98,label='Synthetic historical prompt fixture, never executed',status='failed',current_stage='rebalance',
            error_message='Synthetic saved prompt history only',orchestration_kind='analysis_v1',
            request_key='synthetic-prompt-history-fixture',execution_json=execution,control_version=1)
        e.db.add(prompt_record);e.db.flush()
        for name in STAGES:
            e.db.add(AutoRebalanceWorkflowStage(workflow_id=prompt_record.id,stage=name,status='failed' if name=='rebalance' else 'skipped',
                error_message='Synthetic saved prompt history only' if name=='rebalance' else None,
                attempt_count=0,checkpoint_json={'attempts':[],'job_history':[]}))
        monkeypatch.setenv('LOCAL_NATIVE_PROMPT_HISTORY_WORKFLOW_ID',str(prompt_record.id))

    if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')=='concept-f-legacy-formula':
        # An already-completed synthetic source with an invalid score; never dispatched.
        bad_prompt='[REBALANCE_FLOW:india]\nRebalance scan synthetic out-of-range source'
        bad_run=Run(user_id=1,module_id='zerodha_rebalance',module_version=1,prompt=bad_prompt,
            prompt_preview=bad_prompt,status=JobStatus.COMPLETED,auto_export_enabled=False,
            auto_rebalance_portfolio='india',auto_rebalance_sequence=193,
            auto_rebalance_label='India Run #193 (Rebalance Scan)')
        bad_job=Job(user_id=1,module_id='zerodha_rebalance',module_version=1,provider='fake',model='invalid-score-fixture',
            status=JobStatus.COMPLETED,prompt=bad_prompt,auto_rebalance_portfolio='india',auto_rebalance_sequence=193,
            response=json.dumps({'stocks':[{'Exchange Symbol':'NSE','Stock Symbol':'BADRANGE','Current Units':0,
                'Action (Buy/Add/Sell All/Trim/Hold/Buy New)':'Hold','Final Units':0,
                'Rationale Cruxx':'Synthetic invalid score retained for guard verification','Score Rationale Cruxx':200,
                'Confidence Score (0-100)':0}]}))
        e.db.add_all([bad_run,bad_job]);e.db.flush();e.db.add(RunJob(run_id=bad_run.id,job_id=bad_job.id,stage=1))

    if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')=='concept-f-legacy-formula':
        # Separate positive parser fixture: the retained #97 missing-source cases
        # and #193 rejected score are unchanged. No worker or provider executes.
        for portfolio,module,market,exchange,marker in (
            ('india','zerodha_rebalance','India','NSE','india'),
            ('indmoney_us','indmoney_us','IndMoney US','NASDAQ','us'),
        ):
            cell={'Exchange Symbol':exchange,'Stock Symbol':'VALIDSOURCE','Current Units':0,'Final Units':0,
                  'Action (Buy/Add/Sell All/Trim/Hold/Buy New)':'Hold','Rationale Cruxx':'Completed synthetic source only'}
            for field in ('Score Rationale Cruxx','Score Rationale Technical Setup Short Term 1–3 Months',
                          'Score Rationale - Technical Setup (Medium Term)','Score Rationale - Technical Setup (Long Term)',
                          'Score Rationale - Fundamentals Short Term','Score Rationale - Fundamentals Medium/Long Term'):
                cell[field]=0
            technical='| Exchange Symbol | Stock Symbol | Primary Setup | Secondary Setups | Bias | Premarket trend | Last 5 candles trend | Confidence Score | Trigger Level | Invalidation Level |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n'+f'| {exchange} | VALIDSOURCE | Bottom of rising channel | | Bullish | 0 | 1 | 8.2 | 100 | 90 |'
            for stage,response,prompt,offset in (
                ('Technical',technical,'## Technical Scan Input Bundle\nMarket: '+('India equities' if marker=='india' else 'US equities')+'\n\nSynthetic saved test table only',20),
                ('Rebalance',json.dumps({'stocks':[cell]}),'[REBALANCE_FLOW:'+marker+']\nSynthetic completed source only',10),
            ):
                stamp=e.now-timedelta(seconds=offset)
                run=Run(user_id=1,module_id=module,module_version=1,prompt=prompt,prompt_preview=prompt,
                    status=JobStatus.COMPLETED,auto_export_enabled=False,auto_rebalance_portfolio=portfolio,
                    auto_rebalance_sequence=194,auto_rebalance_label=f'{market} Run #194 ({stage} Scan)',created_at=stamp,updated_at=stamp)
                job=Job(user_id=1,module_id=module,module_version=1,provider='fake',model='positive-'+stage.lower(),
                    status=JobStatus.COMPLETED,prompt=prompt,response=response,auto_rebalance_portfolio=portfolio,
                    auto_rebalance_sequence=194,created_at=stamp,updated_at=stamp)
                e.db.add_all([run,job]);e.db.flush();e.db.add(RunJob(run_id=run.id,job_id=job.id,stage=1))

    if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')=='concept-f-legacy-formula':
        # Populated F38/F39 reference state. These are explicit synthetic saved
        # model cells, not provider results or actual holdings.
        for run_index,models,symbols in ((0,('A','B'),('ALPHA','BETA','GAMMA')),(1,('C',),('DELTA','EPSILON'))):
            prompt='[REBALANCE_FLOW:india]\nSynthetic populated source reference; never executed'
            stamp=e.now-timedelta(days=1,seconds=run_index)
            run=Run(user_id=1,module_id='zerodha_rebalance',module_version=1,prompt=prompt,prompt_preview=prompt,
                status=JobStatus.COMPLETED,auto_export_enabled=False,auto_rebalance_portfolio='india',auto_rebalance_sequence=195,
                auto_rebalance_label='India Run #195 (Rebalance Scan)',created_at=stamp,updated_at=stamp)
            e.db.add(run);e.db.flush()
            for model in models:
                stocks=[]
                for symbol in symbols:
                    units={'ALPHA':24,'BETA':16,'GAMMA':40,'DELTA':0,'EPSILON':2}[symbol]
                    cell={'Exchange Symbol':'NSE','Stock Symbol':symbol,'Current Units':units,'Final Units':units,
                        'Price Per Unit':100,'Action (Buy/Add/Sell All/Trim/Hold/Buy New)':'Hold',
                        'Technical Setup':'Bottom of rising channel' if run_index==0 else 'Support bounce',
                        'Confidence Score (0-100)':68 if model=='A' else 62 if model=='B' else 70,
                        'Rationale Cruxx':'Explicit synthetic populated reference cell'}
                    for field in ('Score Rationale Cruxx','Score Rationale Technical Setup Short Term 1–3 Months',
                            'Score Rationale - Technical Setup (Medium Term)','Score Rationale - Technical Setup (Long Term)',
                            'Score Rationale - Fundamentals Short Term','Score Rationale - Fundamentals Medium/Long Term'):
                        cell[field]=0
                    stocks.append(cell)
                job=Job(user_id=1,module_id='zerodha_rebalance',module_version=1,provider='fake',model='reference-model-'+model,
                    status=JobStatus.COMPLETED,prompt=prompt,response=json.dumps({'stocks':stocks}),
                    auto_rebalance_portfolio='india',auto_rebalance_sequence=195,created_at=stamp,updated_at=stamp)
                e.db.add(job);e.db.flush();e.db.add(RunJob(run_id=run.id,job_id=job.id,stage=1))
    if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')=='concept-f-journal':
        from app.domains.indmoney_us.import_validation import parse_import
        from app.domains.indmoney_us.schemas import IndMoneyUsPortfolioSnapshotCreateRequest
        from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot
        for subject,days,price in ((1,2,45),(1,1,50),(1,0,55),(2,0,9999)):
            captured=e.now-timedelta(days=days)
            current=2*price
            raw='symbol,company_name,currency,quantity,market_price,invested_value,current_value,total_pnl,total_pnl_percent\n'+f'SYNUSD,Synthetic USD history,USD,2,{price},100,{current},{current-100},{current-100}\n'
            data=parse_import(IndMoneyUsPortfolioSnapshotCreateRequest(raw_text=raw,captured_at=captured,format='csv'))
            assert not data['import_provenance']['errors']
            data.update(acceptance_state='accepted',accepted_at=captured,wallet_balance=0.0)
            from app.domains.indmoney_us.import_validation import content_digest
            data['content_hash']=content_digest(data)
            e.db.add(IndMoneyUsPortfolioSnapshot(user_id=subject,**data))
        # Persisted, exactly coeval synthetic sources and historical FX. No
        # runtime override or provider acquisition is installed for this view.
        from decimal import Decimal
        from uuid import uuid4
        from sqlalchemy import select
        from app.domains.fx_rates.models import FxRate
        from app.domains.connections.models import IntegrationConnection
        from app.domains.runs.analysis_workflows.synthetic_journal import proposed_source,TOPIC
        from app.domains.runs.analysis_workflows.contracts import digest
        from app.infrastructure.database.outbox.models import OutboxMessage
        connection=e.db.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id==1,IntegrationConnection.is_current.is_(True)))
        connection.created_at=e.now-timedelta(days=3)
        previous=e.db.scalar(select(OutboxMessage).where(OutboxMessage.topic==TOPIC,OutboxMessage.payload['owner_id'].as_integer()==1).order_by(OutboxMessage.payload['sequence'].as_integer().desc()))
        sequence=previous.payload['sequence']
        for days in (2,1,0):
            captured=e.now-timedelta(days=days);identifier=uuid4();saved=proposed_source(1,connection,identifier,captured);sequence+=1
            e.db.add(OutboxMessage(id=identifier,topic=TOPIC,payload={'schema_version':1,'owner_id':1,'sequence':sequence,'simulation_only':True,'source':saved,'source_hash':digest(saved)}))
            case=os.getenv('LOCAL_NATIVE_CURRENT_FX_CASE','valid');assert case in {'valid','stale'}
            if case=='valid' or days==2:
                e.db.add(FxRate(base_currency='USD',quote_currency='INR',rate=Decimal('90'),source='synthetic-local-history',source_as_of=captured-timedelta(hours=1),fetched_at=e.now,verified=True))
        from app.domains.jobs.models import Job
        from app.shared.types import JobStatus
        for subject,portfolio,count in ((1,'india',2),(1,'indmoney_us',1),(2,'india',4)):
            for index in range(count):
                marker='[ZERODHA_THREATS]' if portfolio=='india' else '[INDMONEY_US_THREATS]'
                e.db.add(Job(user_id=subject,module_id='zerodha_rebalance' if portfolio=='india' else 'indmoney_us',module_version=1,
                    provider='fake',model='saved-metadata-'+str(index),status=JobStatus.COMPLETED,
                    prompt=marker+' Synthetic saved metadata only',response=(
                        '## Summary\n- Main portfolio risk in one sentence: Synthetic saved opinion only\n\n## Table 3: Stock-Level Threat Map\n| Stock Symbol | Threat | Severity |\n| --- | --- | --- |\n| SYNTHETIC0 | Synthetic saved concern | High |\n'+('| SYNTHETIC0 | Second saved concern | Medium |\n' if portfolio=='india' else '')
                        if subject==1 and index==count-1 else 'Synthetic historical model opinion; no current risk authority')))

    if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')=='concept-f-us-research':
        # Explicit synthetic saved position reference, never broker acquisition.
        # Existing workflow/intent receipts remain unchanged and unapproved.
        from sqlalchemy import select
        from uuid import uuid4
        from app.domains.connections.models import IntegrationConnection
        from app.domains.runs.analysis_workflows.synthetic_journal import proposed_source,TOPIC
        from app.domains.runs.analysis_workflows.contracts import digest
        from app.infrastructure.database.outbox.models import OutboxMessage
        current=e.db.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id==1,IntegrationConnection.is_current.is_(True)))
        prior=e.db.scalar(select(OutboxMessage).where(OutboxMessage.topic==TOPIC,OutboxMessage.payload['owner_id'].as_integer()==1).order_by(OutboxMessage.payload['sequence'].as_integer().desc()))
        assert current is not None and prior is not None
        identifier=uuid4();saved=proposed_source(1,current,identifier,e.now)
        saved['net_positions']=[{'exchange':'NSE','tradingsymbol':'SYNTHETIC0','quantity':3,'product':'CNC','m2m':0}]
        saved['content_hash']=digest({key:value for key,value in saved.items() if key!='content_hash'})
        e.db.add(OutboxMessage(id=identifier,topic=TOPIC,payload={'schema_version':1,'owner_id':1,'sequence':prior.payload['sequence']+1,'simulation_only':True,'source':saved,'source_hash':digest(saved)}))

    e.db.commit()
    if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')=='concept-f-journal':
        from app.uat2.combined_history import project as combined_history
        combined_seed=combined_history(e.db,1,analysis)
        print('Combined seed admission:', {'rejected':combined_seed['rejected_sources'],'points':[(p['captured_at'],p['reasons'],p['india'] is not None,p['us'] is not None) for p in combined_seed['points']]})
        assert {p['value_exact'] for p in combined_seed['points'] if p['known']} >= {'8130.03','9030.03'}, combined_seed
        assert combined_seed['rejected_sources']=={'india':0,'us':0}
    engine=create_async_engine('sqlite+aiosqlite:///'+str(e.path))
    monkeypatch.setattr(sessions,'AsyncSessionLocal',async_sessionmaker(engine,expire_on_commit=False))
    app=FastAPI();
    from app.domains.public_service.router import router as public_service
    for router in (auth,modules,connections,public_service):app.include_router(router)
    install_workflow(app,scope=analysis.scope,source_storage=analysis.analysis.source_storage)
    if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')in {'concept-f-model-selection','concept-f-legacy-formula','concept-f-legacy-table','concept-f-cost-history','concept-f-legacy-costs','concept-f-us-research'}:
        # Same actual read handlers already mounted by native UAT2; no write
        # siblings, auth override, provider adapter or claim of native startup.
        from app.domains.jobs.router import router as native_jobs
        for route in native_jobs.routes:
            if route.methods=={'GET'} and route.path in {'/jobs','/jobs/{job_id}'}:
                app.include_router(APIRouter(routes=[route]))
    if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')in {'concept-f-legacy-table','concept-f-legacy-formula','concept-f-long-text','concept-f-activity','concept-f-legacy-costs'}:
        from app.domains.runs.router import router as legacy_runs
        for route in legacy_runs.routes:
            if route.methods=={'GET'} and route.path in {'/runs/auto-rebalance-history','/runs/auto-rebalance-history/{portfolio}/{sequence}'} | ({'/runs','/runs/{run_id}'} if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')=='concept-f-legacy-formula' else set()):
                app.include_router(APIRouter(routes=[route]))
    if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')in {'concept-f-plans','concept-f-journal','concept-f-us-research'}:
        from app.uat2.router import router as native_display
        for route in native_display.routes:
            if route.methods=={'GET'} and route.path in ({'/dashboard/summary'} if os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO')in {'concept-f-journal','concept-f-us-research'} else {'/zerodha/portfolio'}):
                app.include_router(APIRouter(routes=[route]))
    native_mutations=[]
    if os.getenv('LOCAL_NATIVE_F01_NATIVE_ZOOM')=='native-normal-workspace-only':
        native_output=Path(os.environ['LOCAL_NATIVE_BROWSER_EVIDENCE'])
        assert not native_output.exists(),'Fresh evidence directory required for actual native observation'
        native_output.mkdir(parents=True)
        @app.middleware('http')
        async def record_native_methods(request,call_next):
            if request.method not in {'GET','HEAD','OPTIONS'}:
                native_mutations.append({'method':request.method,'path':request.url.path})
            return await call_next(request)
    install_route_policy(app)
    @app.exception_handler(AppException)
    async def failure(request,error):return JSONResponse(status_code=error.status_code,content={'detail':error.message})
    assert app.dependency_overrides=={}
    assert not any(getattr(route.endpoint,'__module__','').startswith('scripts.public_launch') for route in app.routes)
    # Delivery is an explicit in-memory test transport; durable workers are actual.
    for kind,task in worker.tasks.items():
        monkeypatch.setattr(task,'apply_async',lambda *,args,queue,retry,_kind=kind:deliveries.append((_kind,args)))
    stop=threading.Event();errors=deque(maxlen=50)
    def tick():
        while not stop.wait(.25):
            clock[0]=datetime.now(timezone.utc)
            try:
                analysis.relay();worker.relay()
                batch=list(deliveries);deliveries.clear()
                for kind,args in batch:
                    try:
                        task=(analysis.tasks|worker.tasks)[kind];task.run(*args)
                    except Exception as error:
                        errors.append(type(error).__name__)
            except Exception as error:
                errors.append(type(error).__name__)
    backend_port=int(os.environ['LOCAL_NATIVE_BACKEND_PORT']);frontend_port=int(os.environ['LOCAL_NATIVE_FRONTEND_PORT'])
    server=uvicorn.Server(uvicorn.Config(app,host='127.0.0.1',port=backend_port,log_level='warning'))
    server_thread=threading.Thread(target=server.run,daemon=True);server_thread.start()
    runner=threading.Thread(target=tick,daemon=True);runner.start()

    log=open('/tmp/credx-local-native-frontend.log','w')
    frontend=None
    try:
        deadline=time.monotonic()+15
        while not server.started and time.monotonic()<deadline:time.sleep(.05)
        assert server.started
        env={**os.environ,'NEXT_DIST_DIR':os.environ['LOCAL_NATIVE_NEXT_DIR'],'NEXTAUTH_URL':f'http://localhost:{frontend_port}',
            'AUTH_URL':f'http://localhost:{frontend_port}','NEXTAUTH_SECRET':'local-native-synthetic-only','AUTH_SECRET':'local-native-synthetic-only',
            'AUTH_TRUST_HOST':'true','NEXT_PUBLIC_UAT2':'true','NEXT_PUBLIC_UAT2_COMMIT':sha,'BACKEND_API_URL':f'http://127.0.0.1:{backend_port}','API_URL':f'http://127.0.0.1:{backend_port}',
            'LOCAL_NATIVE_BROWSER_URL':f'http://localhost:{frontend_port}','LOCAL_NATIVE_BROWSER_SHA':sha,
            'LOCAL_NATIVE_BROWSER_HARNESS_SHA':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),
            'LOCAL_NATIVE_BROWSER_EVIDENCE':os.getenv('LOCAL_NATIVE_BROWSER_EVIDENCE','/tmp/credx-local-native-browser')}
        frontend=subprocess.Popen([node,'node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',str(frontend_port)],cwd=root/'frontend',env=env,stdout=log,stderr=log)
        time.sleep(3)
        scenario=os.getenv('LOCAL_NATIVE_BROWSER_SCENARIO','existing')
        scripts={'concept-f-activity':'scripts/concept-f-activity-native-browser.mjs','concept-f-profile':'scripts/concept-f-profile-native-browser.mjs','concept-f-onboarding':'scripts/concept-f-onboarding-native-browser.mjs','concept-f-threats':'scripts/concept-f-threats-native-browser.mjs','concept-f-us-import':'scripts/concept-f-us-import-native-browser.mjs','concept-f-us-research':'scripts/concept-f-us-research-native-browser.mjs','concept-f-long-text':'scripts/concept-f-long-text-native-browser.mjs','concept-f-zero':'scripts/concept-f-zero-native-browser.mjs','concept-f-safety':'scripts/concept-f-safety-native-browser.mjs','existing':'scripts/local-native-composition-browser.mjs',
                 'concept-f-snapshot':'scripts/concept-f-snapshot-native-browser.mjs',
                 'concept-f-research':'scripts/concept-f-research-native-browser.mjs',
                 'concept-f-legacy-table':'scripts/concept-f-legacy-native-browser.mjs',
                 'concept-f-legacy-costs':'scripts/concept-f-legacy-costs-native-browser.mjs',
                 'concept-f-legacy-formula':'scripts/concept-f-formula-native-browser.mjs',
                 'concept-f-cost-history':'scripts/concept-f-cost-history-native-browser.mjs',
                 'concept-f-plans':'scripts/concept-f-plans-native-browser.mjs',
                 'concept-f-utilities':'scripts/concept-f-utilities-native-browser.mjs',
                 'concept-f-library':'scripts/concept-f-library-native-browser.mjs',
                 'concept-f-journal':'scripts/concept-f-journal-native-browser.mjs',
                 'concept-f-model-selection':'scripts/concept-f-model-selection-native-browser.mjs'}
        assert scenario in scripts
        if os.getenv('LOCAL_NATIVE_BROWSER_EVENT_ONLY'):
            assert os.getenv('LOCAL_NATIVE_BROWSER_EVENT_ONLY')=='pinned-read-only' and scenario=='concept-f-legacy-formula' and not os.getenv('LOCAL_NATIVE_BROWSER_CAPTURE_ONLY') and not os.getenv('LOCAL_NATIVE_F01_NATIVE_ZOOM')
            scripts[scenario]='scripts/concept-f-events-native-browser.mjs'
        if os.getenv('LOCAL_NATIVE_BROWSER_POSITION_ONLY'):
            assert os.getenv('LOCAL_NATIVE_BROWSER_POSITION_ONLY')=='recorded-read-only' and scenario=='concept-f-us-research' and not os.getenv('LOCAL_NATIVE_BROWSER_EVENT_ONLY') and not os.getenv('LOCAL_NATIVE_BROWSER_CAPTURE_ONLY') and not os.getenv('LOCAL_NATIVE_F01_NATIVE_ZOOM')
            scripts[scenario]='scripts/concept-f-positions-native-browser.mjs'
        if os.getenv('LOCAL_NATIVE_BROWSER_ANALYTICS_ONLY'):
            assert os.getenv('LOCAL_NATIVE_BROWSER_ANALYTICS_ONLY')=='source-read-only' and scenario=='concept-f-journal' and not os.getenv('LOCAL_NATIVE_BROWSER_POSITION_ONLY') and not os.getenv('LOCAL_NATIVE_BROWSER_EVENT_ONLY') and not os.getenv('LOCAL_NATIVE_BROWSER_CAPTURE_ONLY') and not os.getenv('LOCAL_NATIVE_F01_NATIVE_ZOOM')
            scripts[scenario]='scripts/concept-f-analytics-native-browser.mjs'
        if os.getenv('LOCAL_NATIVE_BROWSER_RECOMMENDATION_HISTORY_ONLY'):
            assert os.getenv('LOCAL_NATIVE_BROWSER_RECOMMENDATION_HISTORY_ONLY') in ('persisted-context-read-only','captured-workspace-read-only','calculation-sheet-read-only') and scenario=='concept-f-legacy-formula' and not any(os.getenv(key) for key in ('LOCAL_NATIVE_BROWSER_STOCK_MATRIX_ONLY','LOCAL_NATIVE_BROWSER_PRIVACY_ONLY','LOCAL_NATIVE_BROWSER_RESEARCH_MODES_ONLY','LOCAL_NATIVE_BROWSER_SETUP_ONLY','LOCAL_NATIVE_BROWSER_ANALYTICS_ONLY','LOCAL_NATIVE_BROWSER_POSITION_ONLY','LOCAL_NATIVE_BROWSER_EVENT_ONLY','LOCAL_NATIVE_BROWSER_CAPTURE_ONLY','LOCAL_NATIVE_F01_NATIVE_ZOOM'))
            scripts[scenario]='scripts/concept-f-calculation-sheet-native-browser.mjs' if os.getenv('LOCAL_NATIVE_BROWSER_RECOMMENDATION_HISTORY_ONLY')=='calculation-sheet-read-only' else 'scripts/concept-f-captured-stock-native-browser.mjs' if os.getenv('LOCAL_NATIVE_BROWSER_RECOMMENDATION_HISTORY_ONLY')=='captured-workspace-read-only' else 'scripts/concept-f-recommendation-history-native-browser.mjs'
        if os.getenv('LOCAL_NATIVE_BROWSER_STOCK_MATRIX_ONLY'):
            assert os.getenv('LOCAL_NATIVE_BROWSER_STOCK_MATRIX_ONLY') in ('selected-read-only','explicit-advisory-save') and scenario=='concept-f-legacy-formula' and not any(os.getenv(key) for key in ('LOCAL_NATIVE_BROWSER_PRIVACY_ONLY','LOCAL_NATIVE_BROWSER_RESEARCH_MODES_ONLY','LOCAL_NATIVE_BROWSER_SETUP_ONLY','LOCAL_NATIVE_BROWSER_ANALYTICS_ONLY','LOCAL_NATIVE_BROWSER_POSITION_ONLY','LOCAL_NATIVE_BROWSER_EVENT_ONLY','LOCAL_NATIVE_BROWSER_CAPTURE_ONLY','LOCAL_NATIVE_F01_NATIVE_ZOOM'))
            scripts[scenario]='scripts/concept-f-stock-matrix-save-native-browser.mjs' if os.getenv('LOCAL_NATIVE_BROWSER_STOCK_MATRIX_ONLY')=='explicit-advisory-save' else 'scripts/concept-f-stock-matrix-native-browser.mjs'
        if os.getenv('LOCAL_NATIVE_BROWSER_PRIVACY_ONLY'):
            assert os.getenv('LOCAL_NATIVE_BROWSER_PRIVACY_ONLY')=='review-only-partial' and scenario=='concept-f-utilities' and not any(os.getenv(key) for key in ('LOCAL_NATIVE_BROWSER_RESEARCH_MODES_ONLY','LOCAL_NATIVE_BROWSER_SETUP_ONLY','LOCAL_NATIVE_BROWSER_ANALYTICS_ONLY','LOCAL_NATIVE_BROWSER_POSITION_ONLY','LOCAL_NATIVE_BROWSER_EVENT_ONLY','LOCAL_NATIVE_BROWSER_CAPTURE_ONLY','LOCAL_NATIVE_F01_NATIVE_ZOOM'))
        if os.getenv('LOCAL_NATIVE_BROWSER_RESEARCH_MODES_ONLY'):
            assert os.getenv('LOCAL_NATIVE_BROWSER_RESEARCH_MODES_ONLY') in {'four-modes-lost-ack-only','csv-constraints-preview-only'} and scenario=='concept-f-us-research' and not any(os.getenv(key) for key in ('LOCAL_NATIVE_BROWSER_SETUP_ONLY','LOCAL_NATIVE_BROWSER_ANALYTICS_ONLY','LOCAL_NATIVE_BROWSER_POSITION_ONLY','LOCAL_NATIVE_BROWSER_EVENT_ONLY','LOCAL_NATIVE_BROWSER_CAPTURE_ONLY','LOCAL_NATIVE_F01_NATIVE_ZOOM'))
        if os.getenv('LOCAL_NATIVE_BROWSER_SETUP_ONLY'):
            assert os.getenv('LOCAL_NATIVE_BROWSER_SETUP_ONLY')=='inert-read-only' and scenario=='concept-f-legacy-formula' and not os.getenv('LOCAL_NATIVE_BROWSER_ANALYTICS_ONLY') and not os.getenv('LOCAL_NATIVE_BROWSER_POSITION_ONLY') and not os.getenv('LOCAL_NATIVE_BROWSER_EVENT_ONLY') and not os.getenv('LOCAL_NATIVE_BROWSER_CAPTURE_ONLY') and not os.getenv('LOCAL_NATIVE_F01_NATIVE_ZOOM')
            scripts[scenario]='scripts/concept-f-setup-native-browser.mjs'
        if os.getenv('LOCAL_NATIVE_BROWSER_CAPTURE_ONLY'):
            assert os.getenv('LOCAL_NATIVE_BROWSER_CAPTURE_ONLY')=='source-bound-read-only' and scenario=='concept-f-legacy-formula'
            scripts[scenario]='scripts/concept-f-visual-capture.mjs'
        try:
            if os.getenv('LOCAL_NATIVE_F01_NATIVE_ZOOM')in {'native-guest-only','native-normal-workspace-only'}:
                # Keep the actual guarded application/services, without a second
                # Chrome process competing with the supported native controller.
                normal=os.getenv('LOCAL_NATIVE_F01_NATIVE_ZOOM')=='native-normal-workspace-only'
                assert scenario==('concept-f-journal' if normal else 'concept-f-onboarding')
                output=Path(env['LOCAL_NATIVE_BROWSER_EVIDENCE']);output.mkdir(parents=True,exist_ok=True)
                (output/'native-zoom-ready.json').write_text(json.dumps({'base':env['LOCAL_NATIVE_BROWSER_URL'],'source_sha':sha}))
                observation=output/'native-zoom-observed.json';deadline=time.monotonic()+300
                while not observation.exists() and time.monotonic()<deadline:time.sleep(.2)
                assert observation.exists(),'Bounded native observation unavailable'
                observed=json.loads(observation.read_text())
                record={'source_sha':sha,'kind':'actual_native_normal_workspace_observation' if normal else 'actual_native_guest_ui_observation','sqlite':True,'postgresql':False,'redis':False,'hosted':False,'headless_browser_launched':False,'passed':False,'native_observation':observed}
                required={'source_sha':sha,'url':env['LOCAL_NATIVE_BROWSER_URL']+'/console/profile/get-started','guest_window':True,'zoom_percent':200,'keyboard_focus':'Continue','keyboard_activation':'Connect or import','restored_percent':100,'guest_closed':True}
                if normal:
                    from scripts.public_launch.concept_f_native_qualification import verify_native_workspace_observation
                    verify_native_workspace_observation(observed,sha,env['LOCAL_NATIVE_BROWSER_URL'])
                    forbidden=[row for row in native_mutations if (row['method'],row['path']) not in {('POST','/auth/login'),('POST','/auth/logout'),('POST','/auth/refresh')}]
                    record['native_backend_mutations']=native_mutations
                    record['financial_or_configuration_mutations']=forbidden
                    record['passed']=not forbidden
                else:record['passed']=all(observed.get(key)==value for key,value in required.items())
                (output/'receipt.json').write_text(json.dumps(record,indent=2)+'\n')
                assert record['passed'],'Native observation incomplete; no qualification inferred'
            else:
                if os.getenv('LOCAL_NATIVE_F53_ZOOM'):
                    assert os.getenv('LOCAL_NATIVE_F53_ZOOM')=='isolated-synthetic-only' and scenario=='concept-f-legacy-formula' and os.getenv('LOCAL_NATIVE_BROWSER_RECOMMENDATION_HISTORY_ONLY')=='calculation-sheet-read-only'
                subprocess.run([node,scripts[scenario]],cwd=root/'frontend',env=env,check=True,timeout=420 if os.getenv('LOCAL_NATIVE_F53_ZOOM') or os.getenv('LOCAL_NATIVE_BROWSER_CAPTURE_ONLY') or os.getenv('LOCAL_NATIVE_F01_NATIVE_ZOOM')=='visible-zoom-qualification' else 180)
        finally:
            evidence=Path(env['LOCAL_NATIVE_BROWSER_EVIDENCE'])/'receipt.json'
            if evidence.exists():
                record=json.loads(evidence.read_text())
                try:
                    after=verified_build(build,root/'backend/app')
                    record['runtime_cache_observed']=after['observed_runtime_cache_paths']
                    assert record.get('source_sha')==sha
                    record['source_binding_verified']=True
                except Exception as error:
                    record['source_binding_verified']=False;record['source_binding_error']=str(error)
                    raise
                finally:
                    record['build_binding']=build_binding;record['harness_sha']=env['LOCAL_NATIVE_BROWSER_HARNESS_SHA']
                    evidence.write_text(json.dumps(record,indent=2)+'\n')
        receipt=json.loads((Path(env['LOCAL_NATIVE_BROWSER_EVIDENCE'])/'receipt.json').read_text())
        assert receipt['passed'] and receipt['source_sha']==sha
    finally:
        stop.set();runner.join(timeout=5);server.should_exit=True;server_thread.join(timeout=10)
        if frontend is not None:
            frontend.terminate()
            try:frontend.wait(timeout=10)
            except subprocess.TimeoutExpired:frontend.kill();frontend.wait(timeout=5)
        Path('/tmp/credx-local-native-worker-errors.json').write_text(json.dumps(list(errors)))
        log.close()
        asyncio.run(engine.dispose())
