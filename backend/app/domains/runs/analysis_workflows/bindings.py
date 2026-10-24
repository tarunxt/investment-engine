"""Reconstruct the exact approved analysis request from persisted checkpoints."""
from copy import deepcopy
import json
from .contracts import STAGES,digest,WorkflowDenied


def frozen_request(row,stage,dependencies):
    e=row.execution_json
    try:
        target=e['plan']['stages'][stage.stage]
        if not all(isinstance(target.get(k),str) and target[k] for k in ['provider','model','prompt_version','template']):
            raise WorkflowDenied('Approved model/prompt plan required')
        if not isinstance(e['plan']['version'],str) or not e['plan']['version']:
            raise WorkflowDenied('Versioned approved plan required')
        from .shortlist import prompt_context
        setup=prompt_context(row)
        facts={'immutable_source':e['source'],'dependencies':dependencies}
        if setup is not None:facts['research_setup']=setup
        prompt=target['template']+'\n'+json.dumps(facts,sort_keys=True,allow_nan=False)
        context={'kind':'durable_analysis_v1','workflow_id':row.id,'stage':stage.stage,
                 'source_hash':e['source_hash'],'plan_hash':e['plan_hash'],
                 'prompt_version':target['prompt_version'],'plan_version':e['plan']['version'],
                 'analysis_only':True,'orders_authorized':False}
        if setup is not None:context['research_setup_hash']=e['research_setup_hash']
        if e['plan'].get('guardrails_version')=='stage13-v1':
            context['guardrails_version']='stage13-v1'
        return {'provider':target['provider'],'model':target['model'],'prompt':prompt,'context':context}
    except (KeyError,TypeError,ValueError):
        raise WorkflowDenied('Incomplete frozen analysis request') from None


def dependency_results(stages,stage):
    prior=stages[:STAGES.index(stage.stage)]
    if any(s.status!='completed' or not isinstance(s.checkpoint_json,dict)
           or digest(s.checkpoint_json.get('result'))!=s.checkpoint_json.get('result_hash') for s in prior):
        raise WorkflowDenied('Persisted analysis dependencies changed')
    return [deepcopy(s.checkpoint_json['result']) for s in prior]


def validate_job_request(row,stage,job,dependencies):
    expected=frozen_request(row,stage,dependencies)
    if (job is None or job.id!=stage.job_id or job.user_id!=row.user_id
        or job.module_id!=row.module_id or job.module_version!=row.module_version
        or job.provider!=expected['provider'] or job.model!=expected['model']
        or job.prompt!=expected['prompt']
        or job.auto_rebalance_portfolio!=row.portfolio or job.auto_rebalance_sequence!=row.sequence
        or job.auto_rebalance_label!=row.label or not isinstance(job.request_context_json,dict)
        or any(type(job.request_context_json.get(k)) is not type(v) or job.request_context_json.get(k)!=v
               for k,v in expected['context'].items())):
        raise WorkflowDenied('Actual analysis job differs from frozen request')
