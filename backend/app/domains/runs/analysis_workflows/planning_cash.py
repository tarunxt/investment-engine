"""Exact manual-import planning math; never live funds or a broker receipt."""
from copy import deepcopy
from decimal import Decimal,localcontext
from app.domains.ai_limits.validation import number


def project_cash(plan,cash,*,snapshot_hash,policy=None):
    result=deepcopy(plan);balance=number(cash)
    if balance is None or balance<0:
        return {**result,'manual_validation':{'ready':False,'live_funds_verified':False,'notice':'Accepted import cash is missing or invalid. Import a validated wallet balance; no zero cash is inferred.','snapshot_hash':snapshot_hash}}
    with localcontext() as ctx:
        ctx.prec=80
        before=Decimal(0);after=Decimal(0);buys=Decimal(0);sells=Decimal(0);known=True;positions=[]
        for item in result['actions']:
            current=Decimal(item['current_units']);final=Decimal(item['final_units']);price=number(item['source_price'])
            if price is None or price<=0:
                if current or final:known=False
                continue
            before+=current*price;after+=final*price;change=(final-current)*price
            positions.append(final*price)
            if change>0:buys+=change
            else:sells-=change
        cash_after=balance+sells-buys if known else None;equity=balance+before
        policy=policy or {'minimum_cash':'0','maximum_position_percent':'100','maximum_turnover_percent':'100'}
        turnover=(buys+sells)/equity*100 if known and equity>0 else None
        concentration=max(positions,default=Decimal(0))/equity*100 if known and equity>0 else None
        within=known and cash_after>=Decimal(policy['minimum_cash']) and (turnover is None and not buys and not sells or turnover is not None and turnover<=Decimal(policy['maximum_turnover_percent'])) and (concentration is None and not after or concentration is not None and concentration<=Decimal(policy['maximum_position_percent']))
        result.update(cash_before=str(balance),cash_after=str(cash_after) if cash_after is not None else None,
            manual_validation={'ready':bool(within and balance>=buys),'live_funds_verified':False,'snapshot_hash':snapshot_hash,
                'source':'accepted_manual_import','buy_funds_required_without_assumed_sales':str(buys) if known else None,
                'source_exposure_before':str(before) if known else None,'source_exposure_after':str(after) if known else None,
                'gross_turnover_percent':str(turnover) if turnover is not None else None,
                'notice':'Source-price/manual wallet estimate only, excluding charges/taxes. Sale proceeds are not assumed available for buy funding. Check current funds in INDmoney separately; checklist completion is self-reported.'})
    return result
