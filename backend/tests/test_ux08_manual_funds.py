from copy import deepcopy
import pytest
from app.domains.runs.analysis_workflows.planning_cash import project_cash

def plan(targets):return {'actions':[{'instrument':name,'current_units':current,'final_units':final,'source_price':price} for name,current,final,price in targets],'cash_before':None,'cash_after':None}

@pytest.mark.parametrize('targets,cash,after,ready',[
    ([('US:A','2','0','10')],'0','20',True),
    ([('US:A','0','2','10')],'20','0',True),
    ([('US:A','0','2','10')],'19','-1',False),
    ([('US:A','2','0','10'),('US:B','0','1','5')],'5','20',True),
    ([('US:A','2','0','10'),('US:B','0','1','5')],'0','15',False),
])
def test_manual_revisions_recalculate_buy_sell_mixed_cash_without_crediting_unsettled_sales(targets,cash,after,ready):
    original=plan(targets);before=deepcopy(original);result=project_cash(original,cash,snapshot_hash='a'*64)
    assert original==before and result['cash_after']==after and result['manual_validation']['ready'] is ready
    assert result['manual_validation']['live_funds_verified'] is False


@pytest.mark.parametrize('cash,price',[(None,'10'),('NaN','10'),('20',None)])
def test_missing_cash_or_price_never_becomes_zero_or_authority(cash,price):
    result=project_cash(plan([('US:A','1','2',price)]),cash,snapshot_hash='a'*64)
    assert result['manual_validation']['ready'] is False and result['cash_after'] is None


@pytest.mark.parametrize('key,value',[('minimum_cash','20'),('maximum_position_percent','0'),('maximum_turnover_percent','0')])
def test_reviewed_manual_constraints_are_reapplied_to_revised_targets(key,value):
    policy={'minimum_cash':'0','maximum_position_percent':'100','maximum_turnover_percent':'100',key:value}
    result=project_cash(plan([('US:A','1','2','10')]),'20',snapshot_hash='a'*64,policy=policy)
    assert result['manual_validation']['ready'] is False
