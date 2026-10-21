"""Synthetic manual import fixtures only; real local isolated SQLite, no network."""
import asyncio
from datetime import datetime,timezone,timedelta
from types import SimpleNamespace
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
from app.infrastructure.database.base import Base
import app.infrastructure.database.all_models
from app.domains.auth.models import User
from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot as Snapshot
from app.domains.indmoney_us.schemas import IndMoneyUsPortfolioSnapshotCreateRequest as Request
from app.domains.indmoney_us.import_validation import CSV_TEMPLATE,parse_import,require_recommendation_snapshot,number
from app.domains.indmoney_us.import_service import ManualImportService
from app.domains.indmoney_us.repository import IndMoneyUsPortfolioSnapshotRepository
from app.shared.exceptions import ValidationException,NotFoundException,ConflictException

NOW=datetime.now(timezone.utc)
def request(raw=CSV_TEMPLATE,**kw):return Request(raw_text=raw,captured_at=NOW,format='csv',**kw)

@pytest.mark.parametrize('bad',['NaN','inf','1,23','1.2.3','1e4','true','--1','1 000','1000000000000000.01','0.1234567890123456789'])
def test_strict_number_rejects_malformed_and_nonfinite(bad):
    with pytest.raises(ValueError):number(bad)

def test_good_preview_is_not_accepted_and_hash_is_stable():
    a=parse_import(request());b=parse_import(request());assert a['acceptance_state']=='preview' and a['content_hash']==b['content_hash'];assert a['import_provenance']['fx']['conversion']=='none'

@pytest.mark.parametrize('raw',[
 CSV_TEMPLATE.replace('USD','INR'),CSV_TEMPLATE.replace(',2,55',',-2,55'),
 CSV_TEMPLATE.replace(',100,110,10,10',',100,110,-10,10'),
 CSV_TEMPLATE.replace('Synthetic Alpha','Reports'),CSV_TEMPLATE+CSV_TEMPLATE.splitlines()[1]+'\n',
 CSV_TEMPLATE.replace('Synthetic Alpha','Synthetic, Alpha'),CSV_TEMPLATE.replace(',2,55',',2,NaN'),
 CSV_TEMPLATE.replace(',100,110,10,10',',100,110,10,-10'),
])
def test_bad_inputs_are_quarantined(raw):
    parsed=parse_import(request(raw));assert parsed['acceptance_state']=='quarantined';assert parsed['import_provenance']['errors']

def test_missing_quote_is_missing_and_not_zero():
    parsed=parse_import(request(CSV_TEMPLATE.replace(',2,55,',',2,,')));assert parsed['holdings'][0]['market_price'] is None;assert parsed['acceptance_state']=='preview';assert 'Missing quote' in ' '.join(parsed['import_provenance']['warnings'])

def test_missing_value_is_quarantined_not_filled_from_quote():
    parsed=parse_import(request(CSV_TEMPLATE.replace(',100,110,',',100,,')));assert parsed['current_value'] is None;assert parsed['acceptance_state']=='quarantined'

def test_daily_mismatch_is_not_assumed_parser_error():
    raw='Current Value\n$110\nInvested Value\n$100\n1D Returns\n-$2 (+1%)\nCurrent Holdings (1)\nReports\nSynthetic Alpha\nUATA\n$55\n$100\n2 Qty\n$50 Avg.\n$110\n+$10\n+10%'
    parsed=parse_import(Request(raw_text=raw,captured_at=NOW,day_return_period='1d_same_asof'));assert parsed['acceptance_state']=='quarantined';assert parsed['day_return_value']==-2 and parsed['day_return_percent']==1;assert parsed['holdings'][0]['company_name']=='Synthetic Alpha'

def test_stale_time_and_currency_provenance_are_visible():
    r=request();r.captured_at=NOW-timedelta(days=4);parsed=parse_import(r);assert any('Stale snapshot' in w for w in parsed['import_provenance']['warnings'])
    r=request(currency='EUR');assert parse_import(r)['acceptance_state']=='quarantined'

def test_naive_time_rejected():
    with pytest.raises(ValueError):Request(raw_text=CSV_TEMPLATE,captured_at=datetime(2026,1,1))

async def scenario(body):
    engine=create_async_engine('sqlite+aiosqlite:///:memory:')
    async with engine.begin() as con:await con.run_sync(lambda c:Base.metadata.create_all(c,tables=[User.__table__,Snapshot.__table__]))
    factory=async_sessionmaker(engine,expire_on_commit=False)
    try:
        async with factory() as db:await body(db)
    finally:await engine.dispose()

def test_preview_acceptance_owner_scope_duplicates_and_correction_history():
    async def body(db):
        svc=ManualImportService(db);a=await svc.preview(1,request());await db.commit()
        assert a.acceptance_state=='preview' and await IndMoneyUsPortfolioSnapshotRepository(db).get_latest_by_user(1) is None
        duplicate=await svc.preview(1,request());assert duplicate.id==a.id
        with pytest.raises(NotFoundException):await svc.accept(2,a.id,a.content_hash)
        with pytest.raises(ConflictException):await svc.accept(1,a.id,'0'*64)
        accepted=await svc.accept(1,a.id,a.content_hash);await db.commit();require_recommendation_snapshot(accepted)
        assert (await svc.accept(1,a.id,a.content_hash)).id==a.id
        with pytest.raises(NotFoundException):await svc.preview(2,request(supersedes_id=a.id))
        corrected=await svc.preview(1,request(CSV_TEMPLATE.replace(',2,55,100,110,10,10',',2,60,100,120,20,20'),supersedes_id=a.id));await svc.accept(1,corrected.id,corrected.content_hash);await db.commit()
        old=await svc.owned(1,a.id);assert old.holdings[0]['current_value']==110 and corrected.supersedes_id==a.id
        assert len((await db.scalars(select(Snapshot))).all())==2
        accepted.raw_text='tampered'
        with pytest.raises(ValueError,match='immutable'):await db.flush()
        await db.rollback()
    asyncio.run(scenario(body))

def test_quarantine_and_stale_never_feed_recommendation():
    async def body(db):
        svc=ManualImportService(db);bad=await svc.preview(1,request(CSV_TEMPLATE.replace('Synthetic Alpha','Reports')));await db.commit()
        with pytest.raises(ValidationException):await svc.accept(1,bad.id,bad.content_hash)
        r=request();r.captured_at=NOW-timedelta(days=4);stale=await svc.preview(1,r);await svc.accept(1,stale.id,stale.content_hash);await db.commit()
        with pytest.raises(ValidationException,match='stale'):require_recommendation_snapshot(stale)
    asyncio.run(scenario(body))

from test_private_api_ownership import private_api

def test_actual_http_preview_accept_and_direct_legacy_bypass(private_api):
    a=private_api;body={'raw_text':CSV_TEMPLATE,'captured_at':NOW.isoformat(),'format':'csv','currency':'USD'}
    assert a.client.post('/indmoney-us/imports/preview',json=body).status_code==401
    assert a.client.post('/indmoney-us/portfolio',json=body,headers=a.headers[0]).status_code==422
    preview=a.client.post('/indmoney-us/imports/preview',json=body,headers=a.headers[0]);assert preview.status_code==200,preview.text
    row=preview.json();assert row['acceptance_state']=='preview'
    assert a.client.get('/indmoney-us/portfolio',headers=a.headers[0]).json()['latest'] is None
    path=f"/indmoney-us/imports/{row['id']}/accept";accept={'content_hash':row['content_hash'],'accept':True}
    assert a.client.post(path,json=accept,headers=a.headers[1]).status_code==404
    assert a.client.post(path,json={**accept,'accept':False},headers=a.headers[0]).status_code==422
    assert a.client.post(path,json={**accept,'content_hash':'0'*64},headers=a.headers[0]).status_code==409
    accepted=a.client.post(path,json=accept,headers=a.headers[0]);assert accepted.status_code==200,accepted.text
    assert accepted.json()['acceptance_state']=='accepted'
    assert a.client.post(path,json=accept,headers=a.headers[0]).json()['id']==row['id']
    assert a.client.get(f"/indmoney-us/portfolio/{row['id']}",headers=a.headers[1]).status_code==404
    duplicate=a.client.post('/indmoney-us/imports/preview',json=body,headers=a.headers[0]);assert duplicate.json()['id']==row['id']
    assert a.client.get('/indmoney-us/portfolio',headers=a.headers[0]).json()['latest']['id']==row['id']

def test_actual_http_template_and_quarantine_are_owned(private_api):
    a=private_api;assert a.client.get('/indmoney-us/imports/template').status_code==401
    template=a.client.get('/indmoney-us/imports/template',headers=a.headers[0]);assert template.status_code==200 and template.text==CSV_TEMPLATE
    body={'raw_text':CSV_TEMPLATE.replace('Synthetic Alpha','Reports'),'captured_at':NOW.isoformat(),'format':'csv'}
    r=a.client.post('/indmoney-us/imports/preview',json=body,headers=a.headers[0]).json();assert r['acceptance_state']=='quarantined'
    assert a.client.post(f"/indmoney-us/imports/{r['id']}/accept",json={'content_hash':r['content_hash'],'accept':True},headers=a.headers[0]).status_code==422

@pytest.mark.parametrize('broken',['$1,23','$1.2.3','$12,,345'])
def test_malformed_pasted_numbers_quarantine_even_when_substring_parser_reads_value(broken):
    raw=f'Current Holdings (1)\nSynthetic Alpha\nUATA\n$55\n$100\n2 Qty\n$50 Avg.\n{broken}\n+$10\n+10%'
    parsed=parse_import(Request(raw_text=raw,captured_at=NOW));assert parsed['acceptance_state']=='quarantined';assert any('Malformed' in e for e in parsed['import_provenance']['errors'])

def test_accepted_payload_tampering_and_unknown_currency_block_recommendations():
    data=parse_import(request());snap=SimpleNamespace(id=1,**{**data,'acceptance_state':'accepted'});require_recommendation_snapshot(snap)
    snap.holdings=[{**snap.holdings[0],'current_value':999}]
    with pytest.raises(ValidationException,match='integrity'):require_recommendation_snapshot(snap)

@pytest.mark.parametrize('bad',['$12x3','$1e4','$NaN'])
def test_corrupt_currency_tokens_never_become_valid_source_values(bad):
    raw=f'Current Holdings (1)\nSynthetic Alpha\nUATA\n{bad}\n$100\n2 Qty\n$50 Avg.\n$110\n+$10\n+10%'
    data=parse_import(Request(raw_text=raw,captured_at=NOW));assert data['acceptance_state']=='quarantined'

def test_summary_timestamp_serializes_explicit_utc_after_sqlite_roundtrip():
    from app.domains.indmoney_us.service import IndMoneyUsPortfolioService
    async def body(db):
        row=await ManualImportService(db).preview(1,request());await db.commit();await db.refresh(row)
        dto=IndMoneyUsPortfolioService().serialize_detail(row)
        assert dto['captured_at'].utcoffset()==timedelta(0)
    asyncio.run(scenario(body))

def test_missing_summary_does_not_borrow_the_next_labels_value():
    from app.domains.indmoney_us.service import IndMoneyUsPortfolioService
    raw='Current Value\nNot available\nInvested Value\n$100\nCurrent Holdings (1)\nSynthetic Alpha\nUATA\n$50\n$100\n2 Qty\n$50 Avg.\n$100\n+$0\n0%'
    parsed=IndMoneyUsPortfolioService().parse_snapshot(raw);assert parsed['current_value'] is None
    assert parse_import(Request(raw_text=raw,captured_at=NOW))['acceptance_state']=='quarantined'

def test_missing_pnl_does_not_hide_wrong_percentage_denominator():
    parsed=parse_import(request(CSV_TEMPLATE.replace(',110,10,10',',110,,999')));assert parsed['acceptance_state']=='quarantined'

def test_ambiguous_company_name_mapping_requires_share_class_clarity():
    raw=CSV_TEMPLATE+'UATB,Synthetic Alpha,USD,2,55,100,110,10,10\n'
    assert parse_import(request(raw))['acceptance_state']=='quarantined'

def test_accepted_correction_supersedes_prior_even_when_asof_is_earlier():
    async def body(db):
        svc=ManualImportService(db);prior=await svc.preview(1,request());await svc.accept(1,prior.id,prior.content_hash);await db.commit()
        r=request(CSV_TEMPLATE.replace(',2,55,100,110,10,10',',2,60,100,120,20,20'),supersedes_id=prior.id);r.captured_at=NOW-timedelta(minutes=1)
        corrected=await svc.preview(1,r);await svc.accept(1,corrected.id,corrected.content_hash);await db.commit()
        assert (await IndMoneyUsPortfolioSnapshotRepository(db).get_latest_by_user(1)).id==corrected.id
        assert (await svc.owned(1,prior.id)).holdings[0]['current_value']==110
    asyncio.run(scenario(body))

def test_acceptance_requires_literal_boolean_true():
    from app.domains.indmoney_us.schemas import IndMoneyImportAcceptance
    for value in [False,1,'true',None]:
        with pytest.raises(ValueError):IndMoneyImportAcceptance(content_hash='a'*64,accept=value)

def test_percentage_only_never_becomes_daily_dollars():
    from app.domains.indmoney_us.service import IndMoneyUsPortfolioService
    dollars,percent=IndMoneyUsPortfolioService()._parse_change_with_percent('▲2.3%')
    assert dollars is None and percent==2.3
