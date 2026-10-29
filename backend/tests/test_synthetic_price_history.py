"""Pure declared test-source facts, not market/provider acquisition evidence."""
from copy import deepcopy
from app.domains.runs.analysis_workflows.synthetic_price_history import build,study,validate_if_present
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied,digest
import pytest

def source():return {'owner_id':1,'portfolio':'india','currency':'INR','source_receipt_id':'12345678-1234-1234-1234-123456789012','captured_at':'2026-10-26T00:00:00+00:00','simulation_only':True,'holdings':[{'exchange':'NSE','tradingsymbol':'SYNTHETIC0','last_price':'10.01'}]}

def test_generated_samples_and_study_are_exactly_bound_and_clearly_not_market_data():
    raw=source();body=build(raw)
    assert body['sample_kind']=='generated_test_samples_not_market_observations'
    assert len(body['samples'])==15 and body['samples'][-1]['close']=='10.01'
    assert body['samples'][0]['sample_at']=='2026-10-12T00:00:00+00:00'
    assert body['owner_id']==1 and body['source_receipt_id']==raw['source_receipt_id']
    assert body['history_hash']==digest({key:value for key,value in body.items() if key!='history_hash'})
    assert validate_if_present({**raw,'price_history':body})
    assert 'price_history' not in raw and validate_if_present(raw) is False

@pytest.mark.parametrize('values,rsi,momentum',[
    ([f'{value}.00' for value in range(1,16)],'100.00','above'),
    ([f'{value}.00' for value in range(15,0,-1)],'0.00','below'),
    (['10.00']*15,None,'equal')])
def test_indicator_boundary_cases_never_invent_neutrality_or_risk_classification(values,rsi,momentum):
    result=study(values)
    assert result['rsi_14']==rsi and result['last_vs_sma_5']==momentum
    assert result['volatility_classification'] is None and result['orders_authorized'] is False
    assert result['last_close']==values[-1]

@pytest.mark.parametrize('change',[{'owner_id':2},{'currency':'USD'},{'provider':'live'},{'sample_kind':'market_observed'}, {'samples':[]},{'study':{'rsi_14':'99.00'}},{'history_hash':'0'*64}])
def test_study_cannot_be_copied_relabelled_or_rehashed_into_a_different_evidence_claim(change):
    raw=source();raw['price_history']={**build(raw),**change}
    with pytest.raises(WorkflowDenied):validate_if_present(raw)

@pytest.mark.parametrize('bad',[['10.00']*14,['10.00']*16,['NaN']*15,['0.00']*15,['-1.00']*15,[True]*15])
def test_malformed_or_unbounded_study_inputs_fail_closed(bad):
    with pytest.raises(WorkflowDenied):study(bad)

def test_old_source_is_not_mutated_or_backfilled_and_source_hash_covers_new_bytes():
    old=source();saved=deepcopy(old);before=digest(old)
    assert validate_if_present(old) is False and old==saved
    new={**old,'price_history':build(old)}
    assert digest(new)!=before and old==saved
    with pytest.raises(WorkflowDenied):validate_if_present({**old,'price_history':None})

def test_mixed_initial_ratio_and_moving_average_use_the_actual_declared_samples():
    result=study(['10.00','11.00']*7+['10.00'])
    assert result['rsi_14']=='50.00' and result['gain_sum']=='7.00' and result['loss_sum']=='7.00'
    assert result['sma_5']=='10.4000' and result['sma_14']=='10.5000'
    assert result['last_vs_sma_5']=='below'

def test_generated_bytes_do_not_depend_on_caller_decimal_context():
    from decimal import localcontext
    expected=build(source())
    with localcontext() as context:
        context.prec=3
        assert build(source())==expected
