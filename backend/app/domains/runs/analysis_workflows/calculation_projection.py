"""Read-only historical governed evidence. Never invokes current admission/effects.

Core SELECTs avoid identity-map refresh, autoflush and state-machine row locks.
Legacy Run calculations and their numeric semantics are not used or rewritten.
"""
from types import SimpleNamespace
import json
import re
from sqlalchemy import select, and_
from app.domains.runs.models import AutoRebalanceWorkflow as Workflow, AutoRebalanceWorkflowStage as Stage
from app.domains.jobs.models import Job
from app.shared.types import JobStatus
from app.domains.ai_limits.contracts import BoundaryDenied, digest
from app.domains.ai_limits.projection import frozen_projection
from app.domains.ai_limits.validation import validate_recommendations, number
from app.domains.jobs.output_contracts.validation import _sum
from .bindings import dependency_results, validate_job_request
from .contracts import STAGES, WorkflowDenied
from .shortlist import required as required_candidates
from .research_options import validate_output

MODULES = {'india': 'zerodha_rebalance', 'indmoney_us': 'indmoney_us'}
MISSING = ['confidence', 'rationale', 'scores', 'technical_setup', 'current_quotes',
           'cash', 'fees', 'tax', 'legacy_formula_inputs']


def scope(owner, portfolio):
    if type(owner) is not int or owner < 1 or portfolio not in MODULES:
        raise WorkflowDenied('Known owned calculation source required')


def catalogue(db, owner, portfolio):
    scope(owner, portfolio)
    with db.no_autoflush:
        rows = db.execute(select(Workflow.id, Workflow.control_version, Workflow.status,
            Workflow.module_version, Workflow.created_at).where(
                Workflow.user_id == owner, Workflow.portfolio == portfolio,
                Workflow.orchestration_kind == 'analysis_v1').order_by(
                    Workflow.id.desc()).limit(30)).mappings().all()
    return {'schema_version': 1, 'source_kind': 'governed_stage_jobs', 'owner_id': owner,
            'portfolio': portfolio, 'limit': 30, 'items': [dict(id=row['id'],
                workflow_version=row['control_version'], status=row['status'],
                module_version=row['module_version'], recorded_at=row['created_at'].isoformat()) for row in rows]}


def project(db, owner, portfolio, workflow_id):
    scope(owner, portfolio)
    if type(workflow_id) is not int or workflow_id < 1:
        raise WorkflowDenied('Exact owned workflow required')
    try:
        # One SELECT is one PostgreSQL READ COMMITTED snapshot. Do not combine
        # a workflow from before a transition with Jobs/checkpoints from after it.
        tables = [('w_', Workflow.__table__), ('s_', Stage.__table__), ('j_', Job.__table__)]
        columns = [column.label(prefix + column.name) for prefix, table in tables for column in table.c]
        joined = Workflow.__table__.outerjoin(Stage.__table__, Stage.workflow_id == Workflow.id).outerjoin(
            Job.__table__, and_(Job.id == Stage.job_id, Job.user_id == owner))
        with db.no_autoflush:
            raw = db.execute(select(*columns).select_from(joined).where(
                Workflow.id == workflow_id, Workflow.user_id == owner,
                Workflow.portfolio == portfolio, Workflow.orchestration_kind == 'analysis_v1')).mappings().all()
        if not raw:
            raise WorkflowDenied('Exact owned workflow unavailable')
        def record(item, prefix, table):
            return SimpleNamespace(**{column.name: item[prefix + column.name] for column in table.c})
        row = record(raw[0], 'w_', Workflow.__table__)
        stages = [record(item, 's_', Stage.__table__) for item in raw if item['s_id'] is not None]
        if len(stages) != len(STAGES) or {s.stage for s in stages} != set(STAGES):
            raise WorkflowDenied('Historical stage graph incomplete')
        stages.sort(key=lambda s: STAGES.index(s.stage))
        if any(s.run_id is not None or s.stage == 'sync' and s.job_id is not None for s in stages):
            raise WorkflowDenied('Ambiguous governed/legacy stage binding')
        job_ids = [s.job_id for s in stages if s.job_id is not None]
        if len(set(job_ids)) != len(job_ids):
            raise WorkflowDenied('Duplicate historical job attribution')
        jobs = {item['j_id']: record(item, 'j_', Job.__table__) for item in raw if item['j_id'] is not None}
        if len(jobs) != len(job_ids):
            raise WorkflowDenied('Historical related-job ownership unavailable')
        e = row.execution_json
        if (row.module_id != MODULES[portfolio] or type(row.module_version) is not int
                or row.module_version < 1 or type(row.control_version) is not int
                or not isinstance(e, dict) or digest(e['source']) != e['source_hash']
                or digest(e['plan']) != e['plan_hash'] or e['plan'].get('guardrails_version') != 'stage13-v1'):
            raise WorkflowDenied('Historical frozen binding invalid')
        frozen = frozen_projection(row)
        result = {'schema_version': 1, 'source_kind': 'governed_stage_jobs', 'owner_id': owner,
            'workflow_id': row.id, 'workflow_version': row.control_version, 'portfolio': portfolio,
            'workflow_status': row.status, 'module_version': row.module_version,
            'source_hash': e['source_hash'], 'plan_hash': e['plan_hash'],
            'captured_at': frozen['captured_at'].isoformat(), 'currency': frozen['currency'],
            'simulation': True, 'historical': True, 'orders_authorized': False,
            'current_readiness': 'not_established', 'budget_verification': 'not_assessed',
            'integrity': 'frozen_job_checkpoint_verified', 'missing_fields': MISSING.copy(), 'stages': []}
        for stage in stages:
            view = {'stage': stage.stage, 'status': stage.status, 'job_id': stage.job_id,
                'state': 'not_completed', 'result_hash': None, 'response_hash': None,
                'provider': None, 'model': None, 'prompt_version': None, 'rows': []}
            if stage.status != 'completed':
                result['stages'].append(view)
                continue
            checkpoint = stage.checkpoint_json
            captured = checkpoint['result']
            if (digest(captured) != checkpoint['result_hash'] or captured['owner_id'] != owner
                    or captured['source_hash'] != e['source_hash'] or captured['plan_hash'] != e['plan_hash']):
                raise WorkflowDenied('Historical checkpoint integrity invalid')
            view['result_hash'] = checkpoint['result_hash']
            if stage.stage == 'sync':
                if captured['data'] != e['source']:
                    raise WorkflowDenied('Historical acquisition receipt differs')
                view['state'] = 'not_applicable'
                result['stages'].append(view)
                continue
            job = jobs.get(stage.job_id)
            validate_job_request(row, stage, job, dependency_results(stages, stage))
            if (job.provider != 'fake' or job.status != JobStatus.COMPLETED
                    or not isinstance(job.response, str) or len(job.response.encode()) > 262144
                    or captured['data'] != {'job_id': job.id, 'response': job.response,
                        'tokens_in': job.tokens_in, 'tokens_out': job.tokens_out}):
                raise WorkflowDenied('Historical saved response differs')
            document = json.loads(job.response)
            provenance = {'provider': job.provider, 'model': job.model, 'prompt_hash': digest(job.prompt),
                'input_hash': e['source_hash'], 'prompt_version': job.request_context_json['prompt_version']}
            source = {**frozen, 'content_hash': e['source_hash'], 'provenance': provenance}
            # Reconstruct historical semantic validation at frozen capture, not
            # today. This is expressly NOT current source/budget/order eligibility.
            verdict = validate_recommendations(document, source=source, owner_id=owner,
                module_id=row.module_id, now=frozen['captured_at'],
                allowed_instruments=set(frozen['holdings']), required_instruments=required_candidates(row))
            validate_output(row, document)
            if (job.runtime_metadata_json or {}).get('guardrails') != verdict:
                raise WorkflowDenied('Historical guardrails receipt differs')
            if any(not isinstance(value,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}',value)
                    or re.search(r'^(?:sk-|ghp_|github_pat_|AKIA|ASIA)',value)
                    for value in (job.model,provenance['prompt_version'])):
                raise WorkflowDenied('Historical display label unsupported')
            view.update(state='available', response_hash=digest(document), provider=job.provider,
                model=job.model, prompt_version=provenance['prompt_version'])
            for item in document['recommendations']:
                current, final = number(item['current_units']), number(item['final_units'])
                delta = str(_sum(final, current.copy_negate()))
                if len(delta) > 128:
                    raise WorkflowDenied('Exact arithmetic exceeds bounded display domain')
                view['rows'].append({'id': str(job.id)+':'+item['instrument'],
                    'instrument': item['instrument'], 'action': item['action'],
                    'current_units': str(current), 'final_units': str(final),
                    'allocation': str(number(item['allocation'])),
                    'units_change': delta,
                    'units_change_kind': 'arithmetic_from_recorded_units'})
            result['stages'].append(view)
        result['evidence_hash'] = digest(result)
        return result
    except (BoundaryDenied, KeyError, TypeError, ValueError, AttributeError, RecursionError, OverflowError):
        raise WorkflowDenied('Historical calculation evidence could not be verified') from None
