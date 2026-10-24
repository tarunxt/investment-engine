"""Read-only action-plan projection from verified governed advisory receipts.

Prices are frozen source indications, never executable quotes. Missing cash,
charges and tax evidence remain absent. This projection confers no authority.
"""
from decimal import Decimal
from app.domains.ai_limits.validation import number
from .contracts import WorkflowDenied,digest


def project(receipt,*,workflow,source):
    if receipt.get('owner_id')!=workflow.user_id or receipt.get('workflow_id')!=workflow.id or receipt.get('orders_authorized') is not False or receipt.get('simulation') is not True:
        raise WorkflowDenied('Verified owned simulation receipt required')
    if receipt['source_hash']!=workflow.execution_json['source_hash'] or receipt['plan_hash']!=workflow.execution_json['plan_hash'] or digest(source)!=receipt['source_hash']:
        raise WorkflowDenied('Frozen plan binding differs')
    prices={}
    if isinstance(source.get('holdings'),list):
        for holding in source['holdings']:
            exchange=holding.get('exchange','US') if workflow.portfolio=='indmoney_us' else holding.get('exchange')
            symbol=holding.get('symbol') if workflow.portfolio=='indmoney_us' else holding.get('tradingsymbol')
            price=number(holding.get('market_price') if workflow.portfolio=='indmoney_us' else holding.get('last_price'))
            if isinstance(exchange,str) and isinstance(symbol,str) and price is not None and price>0:prices[exchange+':'+symbol]=price
    rows=[]
    for recommendation in receipt['recommendations']:
        current=number(recommendation['current_units']);final=number(recommendation['final_units'])
        if current is None or final is None or min(current,final)<0:raise WorkflowDenied('Finite advisory quantities required')
        change=final-current;price=prices.get(recommendation['instrument'])
        rows.append({'instrument':recommendation['instrument'],'action':recommendation['action'],
            'side':'buy' if change>0 else 'sell' if change<0 else 'none',
            'current_units':str(current),'final_units':str(final),'quantity':str(abs(change)),
            'source_price':str(price) if price is not None else None,
            'estimated_value':str(abs(change)*price) if price is not None else None,
            'before_source_value':str(current*price) if price is not None else None,
            'after_source_value':str(final*price) if price is not None else None,
            'order_type':None,'order_conditions':None,'rationale':None,
            'evidence_hash':receipt['actionables_result_hash']})
    complete=all(row['source_price'] is not None for row in rows)
    def total(key):return str(sum((Decimal(row[key]) for row in rows),Decimal(0))) if complete else None
    version=digest({'source':receipt['source_hash'],'plan':receipt['plan_hash'],'result':receipt['actionables_result_hash']})
    from .shortlist import verified
    setup=verified(workflow)
    binding=source.get('connection')
    connection={'mode':binding['mode'],'version':binding['version'],'account_label':'***'+binding['account'][-4:]} if binding else None
    return {'schema_version':1,'owner_id':workflow.user_id,'workflow_id':workflow.id,'portfolio':workflow.portfolio,
        'version':version,'source_hash':receipt['source_hash'],'plan_hash':receipt['plan_hash'],
        'result_hash':receipt['actionables_result_hash'],'captured_at':source['captured_at'],
        'connection':connection,'snapshot_id':source.get('snapshot_id'),'currency':source['currency'],
        'simulation':True,'orders_authorized':False,'current':True,
        'no_changes':all(row['side']=='none' for row in rows),'actions':rows,
        'before_source_value':total('before_source_value'),'after_source_value':total('after_source_value'),
        'cash_before':None,'cash_after':None,'estimated_charges':None,'tax_estimate':None,
        'valuation_notice':'Frozen source indications only; no current quote, funds, charges or tax inference',
        'coverage':{'recommendations':len(rows),'candidate_universe_accepted':bool(setup and setup['accepted_instruments']),'accepted_candidates':len(setup['accepted_instruments']) if setup else 0,'raw_rows':setup['raw_rows'] if setup else 0,'analysed_candidates':len(setup['accepted_instruments']) if setup else 0,'rejected_candidates':0,'deferred_candidates':0,'discovery_performed':bool(setup and setup['discovery_performed']),'notice':('Verified offline simulated discovery/merged coverage; all six stages completed. No live provider called.' if setup and setup['discovery_performed'] else 'Verified synthetic shortlist/holdings coverage; discovery suppressed; all six stages completed. Counts are not investment success.') if setup else 'Holdings-only analysis; candidate drafts are excluded. Counts are not investment success.'},
        'amendment':{'available':True,'reason':'Revisions preserve original evidence. Supported targets need a separate funds/exposure assessment and new exact fake approval. Live execution is unavailable; no approval is reused.','max_saved_revisions':20},
        'review_available':workflow.portfolio=='india' and any(row['side']!='none' for row in rows)}
