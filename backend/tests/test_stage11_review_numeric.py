"""Independent review numeric reproductions: synthetic values, no providers."""
import asyncio,hashlib,json
from copy import deepcopy
from datetime import datetime,timezone
from types import SimpleNamespace
import pytest
from app.domains.indmoney_us.import_validation import parse_import,content_digest,require_recommendation_snapshot,validate_financial_data
from app.domains.indmoney_us.import_service import ManualImportService
from app.domains.indmoney_us.schemas import IndMoneyUsPortfolioSnapshotCreateRequest as Request
from app.domains.indmoney_us.service import IndMoneyUsPortfolioService
from app.shared.exceptions import ValidationException
from test_stage11_import_integrity import scenario
from test_private_api_ownership import private_api

HEADER='symbol,company_name,currency,quantity,market_price,invested_value,current_value,total_pnl,total_pnl_percent\n'
NOW=datetime.now(timezone.utc)
def req(raw,format='csv'):return Request(raw_text=raw,captured_at=NOW,format=format,day_return_period='1d_same_asof')
def tiny(current='99.99',pnl='-0.01',percent='0.01'):
    return HEADER+f'UATA,Synthetic Alpha,USD,1,{current},100,{current},{pnl},{percent}\n'
def cents(field='both'):
    return HEADER+'UATA,Synthetic Alpha,USD,1,,1000000000000000,1000000000000000,0,0\nUATB,Synthetic Beta,USD,1,,0.01,0.01,0,0\n'
def oversized():
    return 'Current Value\n$'+'9'*400+'\nInvested Value\n$100\nCurrent Holdings (1)\nSynthetic Alpha\nUATA\n$55\n$100\n2 Qty\n$50 Avg.\n$110\n+$10\n+10%'
def snapshot(data):return SimpleNamespace(id=1,**{**data,'acceptance_state':'accepted'})

@pytest.mark.parametrize('current,pnl,percent',[('99.99','-0.01','0.01'),('100.01','0.01','-0.01'),('99.99','','0.01'),('100.01','','-0.01')])
def test_opposite_nonzero_holding_signs_never_pass_rounding_tolerance(current,pnl,percent):
    data=parse_import(req(tiny(current,pnl,percent)))
    assert data['acceptance_state']=='quarantined'
    assert any('sign' in e.lower() for e in data['import_provenance']['errors'])
    with pytest.raises(ValidationException):require_recommendation_snapshot(snapshot(data))

@pytest.mark.parametrize('pnl,percent',[('-0.01','-0.01'),('0.01','0.01')])
def test_matching_tiny_signs_remain_valid(pnl,percent):
    current='99.99' if pnl.startswith('-') else '100.01'
    data=parse_import(req(tiny(current,pnl,percent)))
    assert data['acceptance_state']=='preview',data['import_provenance']['errors']
    require_recommendation_snapshot(snapshot(data))

def test_exact_aggregate_cent_cannot_disappear_at_storage_boundary():
    data=parse_import(req(cents()))
    assert data['acceptance_state']=='quarantined'
    assert data['current_value'] is None and data['invested_value'] is None
    assert data['import_provenance']['exact_aggregates']['current_value']=='1000000000000000.01'
    assert data['import_provenance']['source_hash']==hashlib.sha256(cents().encode()).hexdigest()
    json.dumps(data,default=str,allow_nan=False)
    with pytest.raises(ValidationException):require_recommendation_snapshot(snapshot(data))

def test_ordinary_decimal_sum_is_not_quarantined_for_binary_float_noise():
    raw=HEADER+'UATA,Synthetic Alpha,USD,1,,0.1,0.1,0,0\nUATB,Synthetic Beta,USD,1,,0.2,0.2,0,0\n'
    data=parse_import(req(raw));assert data['acceptance_state']=='preview',data['import_provenance']['errors']
    assert data['current_value']==data['invested_value']==0.3
    detail=IndMoneyUsPortfolioService().serialize_detail(snapshot(data))
    assert detail['derived']['parsed_holdings_current_value']==0.3

@pytest.mark.parametrize('field',['total_return_percent','total_return_value','day_return_percent'])
def test_aggregate_sign_is_checked_independently_of_tolerance(field):
    data=parse_import(req(tiny('99.99','-0.01','-0.01')))
    if field=='day_return_percent':data.update(day_return_value=-0.01,day_return_percent=0.01)
    else:data[field]=0.01
    data['import_provenance']['errors']=[];data['content_hash']=content_digest(data)
    assert any('sign' in e.lower() or 'disagree' in e.lower() for e in validate_financial_data(data))
    with pytest.raises(ValidationException):require_recommendation_snapshot(snapshot(data))

def test_400_digit_paste_quarantines_with_json_safe_preview_and_exact_source_hash():
    raw=oversized();data=parse_import(req(raw,'paste'))
    assert data['acceptance_state']=='quarantined' and data['current_value'] is None
    assert data['import_provenance']['source_hash']==hashlib.sha256(raw.encode()).hexdigest()
    json.dumps(data,default=str,allow_nan=False)
    detail=IndMoneyUsPortfolioService().serialize_detail(snapshot(data));json.dumps(detail,default=str,allow_nan=False)

def test_actual_http_cannot_accept_review_sign_or_precision_findings(private_api):
    a=private_api
    for raw,format in [(tiny(),'csv'),(cents(),'csv'),(oversized(),'paste')]:
        r=a.client.post('/indmoney-us/imports/preview',json={'raw_text':raw,'captured_at':NOW.isoformat(),'format':format},headers=a.headers[0])
        assert r.status_code==200,r.text
        data=r.json();assert data['acceptance_state']=='quarantined'
        assert data['import_provenance']['source_hash']==hashlib.sha256(raw.encode()).hexdigest()
        accepted=a.client.post(f"/indmoney-us/imports/{data['id']}/accept",json={'accept':True,'content_hash':data['content_hash']},headers=a.headers[0])
        assert accepted.status_code==422


def test_accept_revalidates_instead_of_trusting_prior_preview_error_list():
    async def body(db):
        svc=ManualImportService(db);data=parse_import(req(tiny()))
        # Reproduce an older or corrupt preview whose stored error list and hash
        # look internally consistent. Current validation must still reject it.
        from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot
        data['acceptance_state']='preview';data['import_provenance']['errors']=[];data['parse_warnings']=[];data['content_hash']=content_digest(data)
        row=IndMoneyUsPortfolioSnapshot(user_id=1,**data);db.add(row);await db.commit()
        with pytest.raises(ValidationException):await svc.accept(1,row.id,row.content_hash)
        await db.refresh(row);assert row.acceptance_state=='preview'
    asyncio.run(scenario(body))

@pytest.mark.parametrize('large',['100000000000000','1000000000000000'])
def test_aggregation_checks_precision_even_when_each_row_roundtrips(large):
    raw=cents().replace('1000000000000000',large)
    data=parse_import(req(raw));assert data['acceptance_state']=='quarantined'
    assert data['import_provenance']['exact_aggregates']['current_value']==large+'.01'
    # A previously accepted rounded total must fail even if hashes/error lists
    # have been recomputed consistently by the older buggy implementation.
    data['current_value']=data['invested_value']=float(large)
    data['total_return_value']=data['total_return_percent']=0.0
    data['import_provenance']['errors']=[];data['content_hash']=content_digest(data)
    with pytest.raises(ValidationException):require_recommendation_snapshot(snapshot(data))

@pytest.mark.parametrize('current,pnl,percent',[('99.99','0.01','0.01'),('100.01','-0.01','-0.01')])
def test_dollar_sign_also_matches_exact_price_minus_cost(current,pnl,percent):
    data=parse_import(req(tiny(current,pnl,percent)));assert data['acceptance_state']=='quarantined'
    assert any('sign' in error.lower() for error in data['import_provenance']['errors'])

@pytest.mark.parametrize('replacement',['$'+'9'*400,'9'*400+' Qty'])
def test_nonfinite_holding_fields_quarantine_and_stay_json_safe(replacement):
    raw=oversized().replace('$'+'9'*400,'$110')
    raw=raw.replace('$55',replacement) if replacement.startswith('$') else raw.replace('2 Qty',replacement)
    data=parse_import(req(raw,'paste'));assert data['acceptance_state']=='quarantined'
    assert data['import_provenance']['source_hash']==hashlib.sha256(raw.encode()).hexdigest()
    json.dumps(IndMoneyUsPortfolioService().serialize_detail(snapshot(data)),default=str,allow_nan=False)

def test_source_hash_mismatch_fails_acceptance_and_consumption_even_after_rehashing():
    async def body(db):
        from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot
        data=parse_import(req(tiny('100.01','0.01','0.01')))
        data['import_provenance']['source_hash']='0'*64;data['content_hash']=content_digest(data)
        with pytest.raises(ValidationException,match='provenance'):require_recommendation_snapshot(snapshot(data))
        row=IndMoneyUsPortfolioSnapshot(user_id=1,**data);db.add(row);await db.commit()
        with pytest.raises(ValidationException,match='provenance'):await ManualImportService(db).accept(1,row.id,row.content_hash)
    asyncio.run(scenario(body))

def test_earlier_parser_receipt_remains_history_but_is_not_current_or_reaccepted():
    async def body(db):
        from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot
        from app.domains.indmoney_us.repository import IndMoneyUsPortfolioSnapshotRepository
        data=parse_import(req(tiny('100.01','0.01','0.01')))
        data['import_provenance']['parser_version']='indmoney-manual-2';data['import_key']='2'*64
        data['content_hash']=content_digest(data)
        row=IndMoneyUsPortfolioSnapshot(user_id=1,**{**data,'acceptance_state':'accepted','accepted_at':NOW});db.add(row);await db.commit()
        assert await IndMoneyUsPortfolioSnapshotRepository(db).get_latest_by_user(1) is None
        assert (await ManualImportService(db).owned(1,row.id)).acceptance_state=='accepted'
        assert IndMoneyUsPortfolioService().serialize_detail(row)['parser_current'] is False
        with pytest.raises(ValidationException,match='provenance'):await ManualImportService(db).accept(1,row.id,row.content_hash)
    asyncio.run(scenario(body))
