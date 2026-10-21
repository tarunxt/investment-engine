"""Whitelisted owner snapshot observations; never a live positions assertion."""
from decimal import Decimal, InvalidOperation
from sqlalchemy import select
from .contracts import stored_utc
from app.domains.zerodha.models import ZerodhaPortfolioSnapshot
from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot


def items(value):
    if not isinstance(value, list):return [], True
    out=[]
    invalid=False
    for row in value[:200]:
        if not isinstance(row, dict):invalid=True;continue
        symbol=row.get('tradingsymbol',row.get('symbol'))
        quantity=row.get('quantity')
        try:
            if isinstance(quantity,bool) or not isinstance(quantity,(int,float,str)) or len(str(quantity))>100:raise ValueError()
            quantity=Decimal(str(quantity))
            if not quantity.is_finite() or abs(quantity)>Decimal('1000000000000') or not -18<=quantity.as_tuple().exponent<=12:raise ValueError()
            if not isinstance(symbol,str) or not 1<=len(symbol)<=100:raise ValueError()
        except (InvalidOperation,ValueError):invalid=True;continue
        # Never forward arbitrary imported JSON, raw text, account IDs or tokens.
        out.append({'symbol':symbol,'quantity':format(quantity,'f')})
    return out, invalid or len(value)>200


def owned_positions(db, owner):
    sources=[]
    for model,label,fields in ((ZerodhaPortfolioSnapshot,'India recorded snapshot',('holdings','net_positions','day_positions')),
                               (IndMoneyUsPortfolioSnapshot,'US recorded import',('holdings',))):
        row=db.scalar(select(model).where(model.user_id==owner).order_by(model.captured_at.desc(),model.id.desc()).limit(1))
        entry={'label':label,'snapshot_id':None,'captured_at':None,'verification':'no_record','groups':[],'incomplete':True}
        if row:
            entry.update(snapshot_id=row.id,captured_at=stored_utc(row.captured_at).isoformat(),verification=getattr(row,'acceptance_state','recorded_unverified'))
            if entry['verification'] not in {'quarantined','preview'}:
                for field in fields:
                    projected,incomplete=items(getattr(row,field))
                    entry['groups'].append({'kind':field,'items':projected,'truncated_or_invalid':incomplete})
        sources.append(entry)
    return {'schema_version':1,'owner_id':owner,'read_only':True,'complete_live_positions':False,'sources':sources,
            'notice':'Historical owner snapshots only. These may be stale, unverified, duplicated across holdings/day/net views or linked to an older account. No current account binding, live holdings completeness or liquidation permission is inferred. No broker is contacted.'}
