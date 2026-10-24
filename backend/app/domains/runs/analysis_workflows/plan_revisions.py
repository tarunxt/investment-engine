"""Bounded advisory target revisions in the existing owned stage checkpoint.

Only compact targets/references and calculation hashes are persisted. Original
results/jobs are never rewritten; revised proposals confer no order authority.
"""
from copy import deepcopy
from datetime import datetime,timezone
from decimal import Decimal,localcontext
from app.domains.order_intents.execution_risk import number,ExecutionLimits
from app.shared.exceptions import ConflictException
from .contracts import WorkflowDenied,digest

MAX_REVISIONS=20
ALGORITHM='advisory-source-math-v1'
BINDING=('owner_id','workflow_id','portfolio','source_hash','plan_hash','result_hash')


def targets_for(original,targets):
    if not isinstance(targets,list) or len(targets)!=len(original['actions']):raise WorkflowDenied('Every original instrument needs one exact target')
    result={}
    for item in targets:
        if not isinstance(item,dict) or set(item)!={'instrument','final_units'} or not isinstance(item['instrument'],str) or item['instrument'] in result or type(item['final_units']) is not str:raise WorkflowDenied('Exact unique target quantities required')
        result[item['instrument']]=format(number(item['final_units'],zero=True),'f')
    if set(result)!={item['instrument'] for item in original['actions']}:raise WorkflowDenied('Revision cannot add or omit an instrument')
    return result


def identity(original,parent,targets):return digest({**{key:original[key] for key in BINDING},'parent':parent,'targets':targets,'algorithm':ALGORITHM})


def records(stage,original):
    values=(stage.checkpoint_json or {}).get('advisory_revisions',[])
    if not isinstance(values,list) or len(values)>MAX_REVISIONS:raise WorkflowDenied('Revision history unavailable')
    parent=original['version']
    for item in values:
        if not isinstance(item,dict) or set(item)!={'record','receipt_hash'}:raise WorkflowDenied('Revision receipt required')
        record=item['record']
        required=set(BINDING)|{'algorithm','version','parent','targets','created_at','orders_authorized','math_hash'}
        if not isinstance(record,dict) or set(record)!=required:raise WorkflowDenied('Complete compact revision receipt required')
        if not isinstance(record.get('math_hash'),str) or len(record['math_hash'])!=64:raise WorkflowDenied('Calculation receipt required')
        if not isinstance(record,dict) or digest(record)!=item['receipt_hash'] or record.get('parent')!=parent or any(record.get(key)!=original[key] for key in BINDING) or record.get('algorithm')!=ALGORITHM or not isinstance(record.get('targets'),dict) or record.get('orders_authorized') is not False:
            raise WorkflowDenied('Revision ownership/provenance changed')
        targets=targets_for(original,[{'instrument':name,'final_units':units} for name,units in record['targets'].items()])
        if targets!=record['targets'] or record.get('version')!=identity(original,parent,targets):raise WorkflowDenied('Revision target/version changed')
        parent=record['version']
    return values


def calculate(original,record):
    result=deepcopy(original);gross=Decimal(0);net=Decimal(0);priced=True
    with localcontext() as arithmetic:
        arithmetic.prec=80
        for item in result['actions']:
            current=number(item['current_units'],zero=True);final=Decimal(record['targets'][item['instrument']]);change=final-current
            item.update(final_units=str(final),quantity=str(abs(change)),side='buy' if change>0 else 'sell' if change<0 else 'none',action='buy' if change>0 else 'sell' if final==0 and current>0 else 'trim' if change<0 else 'hold',rationale=None)
            price=number(item['source_price']) if item['source_price'] is not None else None
            item['estimated_value']=str(abs(change)*price) if price is not None else None
            item['after_source_value']=str(final*price) if price is not None else None
            if change and price is None:priced=False
            elif price is not None:gross+=abs(change)*price;net-=change*price
        known=all(item['after_source_value'] is not None for item in result['actions'])
        after=str(sum((Decimal(item['after_source_value']) for item in result['actions']),Decimal(0))) if known else None
    result.update(version=record['version'],revision_parent=record['parent'],revision_created_at=record['created_at'],review_available=False,
        after_source_value=after,no_changes=all(item['side']=='none' for item in result['actions']),estimated_net_cash_impact=str(net) if priced else None,estimated_gross_change_value=str(gross) if priced else None,
        revision_validation={'quantity_schema':'validated','frozen_owned_source':'validated_at_revision','source_value_math':'calculated' if priced else 'missing_prices',
            'funds':'not_established','portfolio_exposure':'not_established','charges_taxes':'not_established',
            'within_default_gross_reference_bound':gross<=Decimal(ExecutionLimits().max_notional) if priced else None,'execution_eligible':False},
        amendment={'available':True,'reason':'Saved target/source-price calculation only. Review the separate current simulated or manual funds assessment; no approval is reused.','max_saved_revisions':MAX_REVISIONS})
    return result


def math_hash(plan):return digest({key:plan[key] for key in ('actions','after_source_value','estimated_net_cash_impact','estimated_gross_change_value','revision_validation')})


def select_plan(stage,original,version=None):
    values=records(stage,original)
    chosen=version or (values[-1]['record']['version'] if values else original['version'])
    if chosen==original['version']:result=deepcopy(original)
    else:
        record=next((item['record'] for item in values if item['record']['version']==chosen),None)
        if record is None:raise WorkflowDenied('Owned plan version required')
        result=calculate(original,record)
        if math_hash(result)!=record['math_hash']:raise WorkflowDenied('Stored revision math no longer verifies')
    return {**result,'versions':[{'version':original['version'],'original':True,'parent':None,'created_at':None},*[{'version':item['record']['version'],'original':False,'parent':item['record']['parent'],'created_at':item['record']['created_at']} for item in values]]}


def revise(stage,original,expected_version,targets,*,now=None):
    values=records(stage,original);normalized=targets_for(original,targets)
    version=identity(original,expected_version,normalized)
    if any(item['record']['version']==version for item in values):return select_plan(stage,original,version)
    parent=values[-1]['record']['version'] if values else original['version']
    if expected_version!=parent:raise ConflictException('Plan changed; reload the latest version before revising')
    current=select_plan(stage,original,parent)
    if all(Decimal(item['final_units'])==Decimal(normalized[item['instrument']]) for item in current['actions']):return current
    if len(values)>=MAX_REVISIONS:raise WorkflowDenied('20 saved revisions reached; no revision is silently discarded')
    record={**{key:original[key] for key in BINDING},'algorithm':ALGORITHM,'version':version,'parent':parent,'targets':normalized,'created_at':(now or datetime.now(timezone.utc)).isoformat(),'orders_authorized':False}
    record['math_hash']=math_hash(calculate(original,record))
    checkpoint=deepcopy(stage.checkpoint_json);checkpoint['advisory_revisions']=[*values,{'record':record,'receipt_hash':digest(record)}];stage.checkpoint_json=checkpoint
    return select_plan(stage,original,version)
