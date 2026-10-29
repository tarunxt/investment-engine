"""Read-only display of the exact journal source used by governed India research."""
from decimal import Decimal,InvalidOperation
from app.domains.ai_limits.validation import number as source_number
from math import isfinite
from app.domains.jobs.output_contracts.validation import _sum,_product
from app.domains.runs.analysis_workflows.synthetic_composition import SyntheticAnalysis
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied,digest

def amount(value):
    try:
        if value is None or isinstance(value,bool):return None
        number=source_number(value)
        if number is None:return None
        return number if number.is_finite() and number>=0 and isfinite(float(number)) else None
    except (InvalidOperation,ValueError,TypeError):return None

def project_snapshot(source,*,historical=False):
    if source.get('currency')!='INR' or not isinstance(source.get('holdings'),list) or not 1<=len(source['holdings'])<=200:
        raise WorkflowDenied('Owned INR holdings source required')
    rows=[];total=Decimal(0);valued=True
    for saved in source['holdings']:
        if not isinstance(saved,dict) or saved.get('exchange') not in {'NSE','BSE'} or not isinstance(saved.get('tradingsymbol'),str) or not saved['tradingsymbol']:
            raise WorkflowDenied('Verified holding identity required')
        quantity=amount(saved['quantity']);price=amount(saved.get('last_price'))
        if quantity is None:raise WorkflowDenied('Verified source quantity required')
        value=_product(quantity,price) if price is not None else None
        value=amount(value)
        if value is None:valued=False
        else:total=_sum(total,value)
        rows.append({'exchange':saved['exchange'],'tradingsymbol':saved['tradingsymbol'],
            'quantity':float(quantity),'quantity_exact':str(saved['quantity']),
            'last_price':float(price) if price is not None else None,
            'last_price_exact':str(saved['last_price']) if price is not None else None,
            'market_value':float(value) if value is not None else None,
            'market_value_exact':str(value) if value is not None else None,
            'average_price':None,'day_change_percentage':None})
    if amount(total) is None:valued=False
    if any(not isinstance(source.get(key,[]),list) or any(not isinstance(row,dict) for row in source.get(key,[])) for key in ('net_positions','day_positions')):raise WorkflowDenied('Verified position record shape required')
    return {'source_receipt_id':source['source_receipt_id'],'snapshot_id':None,'source_hash':digest(source),'content_hash':source['content_hash'],'currency':'INR','captured_at':source['captured_at'],'source':'owned_synthetic_acquisition_journal_history' if historical else 'owned_synthetic_acquisition_journal','holdings':rows,'holdings_market_value':float(total) if valued else None,'holdings_market_value_exact':str(total) if valued else None,'available_margin':None,'positions':{'net':source.get('net_positions'),'day':source.get('day_positions')},'valuation_notice':'Captured fake source prices only; no live quote, full broker holdings, available funds, cost basis or day-change inference.'}

def current_portfolio(db,owner,analysis):
    if type(analysis) is not SyntheticAnalysis or analysis.source_storage!='journal':
        raise WorkflowDenied('Actual installed journal composition required')
    identity=analysis.authorize(db,owner,'india',version=None,scheduled=False)
    source=analysis.source(db,owner,'india',None)
    return {'schema_version':1,'owner_id':owner,'module_version':identity.version,
        'simulation_only':True,'read_only':True,'orders_authorized':False,
        'source_status':'current','complete_live_portfolio':False,'history_complete':False,
        'history_notice':'Only the current validated acquisition is projected. Earlier immutable receipts, if any, are retained, not listed here.',
        'latest':project_snapshot(source),'history':[]}
