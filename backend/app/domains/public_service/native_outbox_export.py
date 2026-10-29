"""Typed owned projections for native simulation evidence; never a raw dump.

Shared/unknown topics, opaque blobs, files, cache and backups remain uncovered.
No route, erasure adapter or automatic full-account completion is installed.
"""
from datetime import datetime,timezone
import json
import re
from types import SimpleNamespace
from uuid import UUID
from sqlalchemy import select,func,cast,Text,LargeBinary,case,exists
from app.domains.ai_limits.contracts import BoundaryDenied,digest
from app.domains.ai_limits.private_effects import TOPIC as ARTIFACT
from app.domains.auth.models import User
from app.domains.connections.models import IntegrationConnection
from app.domains.runs.models import AutoRebalanceWorkflow
from app.domains.runs.analysis_workflows.contracts import TOPIC as STAGE,STAGES
from app.domains.runs.analysis_workflows.synthetic_sources import SimulationSourceScope
from app.domains.runs.analysis_workflows.synthetic_journal import TOPIC as SOURCE,validated
from app.domains.order_intents.models import OrderIntent,OrderLeg
from app.domains.order_intents.service import TOPIC as APPROVAL,Orders
from app.domains.order_intents.execution import venue_binding
from app.domains.order_intents.journal_fake import TOPIC as VENUE,JournalBrokerFake
from app.infrastructure.database.outbox.models import OutboxMessage
from app.uat2.synthetic_connections import TOPIC as CONNECTION
from app.uat2.snapshot_reviews import TOPIC as SNAPSHOT_REVIEW
from app.uat2.synthetic_orders import TOPIC as BASKET,PROVENANCE
from .monitoring import TOPIC as MONITOR
from .monitor_dispatch import FIELDS,MonitorDispatch
from .redaction import redact
from .sql_account import _json_value,_value,_private_value
from .store import owner

TOPICS=frozenset({SOURCE,SNAPSHOT_REVIEW,CONNECTION,STAGE,APPROVAL,BASKET,VENUE,ARTIFACT,MONITOR})
MAX_ROWS=1000
MAX_VALUE=65536
MAX_BYTES=8*1024*1024


def require(value):
    if not value:raise BoundaryDenied('NATIVE_ACCOUNT_EVIDENCE_BINDING_REQUIRED')


def hash_value(value):return type(value) is str and re.fullmatch('[0-9a-f]{64}',value) is not None


def clean(value):
    if type(value) is dict:return {key:clean(item) for key,item in _private_value(value).items()}
    if type(value) is list:return [clean(item) for item in value]
    if type(value) is str:return redact(value)
    return value


class NativeOutboxExport:
    def __init__(self,db,*,scope):
        if type(scope) is not SimulationSourceScope:raise BoundaryDenied('EXPLICIT_NATIVE_ACCOUNT_SCOPE_REQUIRED')
        self.db,self.scope=db,scope

    def resource(self,model,identifier,subject,column='owner_id'):
        if model is AutoRebalanceWorkflow:require(type(identifier) is int and identifier>0)
        else:require(type(identifier) is str and str(UUID(identifier))==identifier)
        value=self.db.scalar(select(model).where(model.id==identifier,getattr(model,column)==subject)
            .execution_options(populate_existing=True))
        require(value is not None)
        return value

    def connection(self,identifier,subject):
        row=self.resource(IntegrationConnection,identifier,subject)
        require(row.provider=='zerodha' and row.credential_ref is None
            and type(row.provider_account_id) is str and row.provider_account_id.startswith('FAKE'))
        return row

    def intent(self,identifier,subject):
        row=self.resource(OrderIntent,identifier,subject)
        require(digest(Orders(None).bound(row))==row.request_digest)
        self.connection(row.connection_id,subject)
        return row

    def project(self,identifier,topic,p,subject):
        require(type(p) is dict)
        if topic!=VENUE:require(type(p.get('owner_id')) is int and p['owner_id']==subject)
        if topic==SNAPSHOT_REVIEW:
            from app.uat2.snapshot_reviews import SnapshotReviews
            from app.domains.runs.analysis_workflows.synthetic_composition import SyntheticAnalysis
            from app.domains.runs.analysis_workflows.runtime import policy
            from app.domains.runs.analysis_workflows.contracts import WorkflowDenied
            try:
                row=SnapshotReviews(SyntheticAnalysis(scope=self.scope,policy=policy,source_storage='journal'))._load(self.db,subject,identifier)
                require(row.payload==p)
                self.connection(p['review']['proposed']['connection']['id'],subject)
                if p['review']['base_receipt'] is not None:
                    base=self.db.get(OutboxMessage,UUID(p['review']['base_receipt']))
                    require(base is not None and base.topic==SOURCE and base.payload.get('owner_id')==subject
                        and base.payload.get('source_hash')==p['review']['base_hash']
                        and digest(base.payload.get('source'))==p['review']['base_hash'])
                return {'kind':'synthetic_snapshot_review','review':p['review'],
                    'review_digest':p['review_digest'],'accepted_receipt':p['accepted_receipt']}
            except (WorkflowDenied,KeyError,TypeError,ValueError):
                raise BoundaryDenied('NATIVE_ACCOUNT_EVIDENCE_BINDING_REQUIRED') from None
        if topic==SOURCE:
            require(set(p)=={'schema_version','simulation_only','owner_id','sequence','source','source_hash'})
            source=p['source'];require(type(source) is dict and type(source.get('owner_id')) is int)
            require(set(source)-{'price_history'}=={'owner_id','portfolio','snapshot_id','source_receipt_id','captured_at','currency',
                'holdings','net_positions','day_positions','connection','simulation_only','content_hash'})
            conn=self.connection(source['connection']['id'],subject)
            capture=datetime.fromisoformat(source['captured_at']);require(capture.tzinfo is not None)
            data=validated(SimpleNamespace(id=identifier,topic=topic,payload=p),subject,conn,capture)
            require(data['currency']=='INR' and len(data['holdings'])<=200)
            return {'kind':'synthetic_acquisition','source':data}
        if topic==CONNECTION:
            require(set(p)=={'schema_version','simulation_only','owner_id','request_hash','connection_id','account',
                'mode','version','prior_connection_id','created_at'})
            require(type(p['version']) is int and p['version']>0)
            require(datetime.fromisoformat(p['created_at']).tzinfo is not None)
            conn=self.connection(p['connection_id'],subject)
            require(p['schema_version']==1 and p['simulation_only'] is True and hash_value(p['request_hash'])
                and (p['account'],p['mode'],p['version'])==(conn.provider_account_id,conn.app_ownership_mode,conn.version))
            if p['prior_connection_id'] is not None:self.connection(p['prior_connection_id'],subject)
            return {'kind':'synthetic_connection','connection_id':conn.id,'mode':p['mode'],'version':p['version'],
                'account':p['account'],'prior_connection_id':p['prior_connection_id'],'created_at':p['created_at']}
        if topic==STAGE:
            require(set(p)=={'owner_id','workflow_id','stage','generation'})
            flow=self.resource(AutoRebalanceWorkflow,p['workflow_id'],subject,'user_id')
            require(flow.orchestration_kind=='analysis_v1' and p['stage'] in STAGES
                and type(p['generation']) is int and 0<=p['generation']<=flow.control_version)
            return {'kind':'analysis_stage_dispatch',**p}
        if topic==APPROVAL:
            require(set(p)=={'owner_id','intent_id','approval_digest','request_digest'})
            intent=self.intent(p['intent_id'],subject)
            require(p['request_digest']==intent.request_digest and p['approval_digest']==Orders(None).approval_hash(intent))
            return {'kind':'exact_synthetic_confirmation',**p,'current_intent_state':intent.state}
        if topic==BASKET:
            require(set(p)=={'schema','simulation','intent_id','owner_id','provenance','request_digest','order_hash','scenario','digest'})
            intent=self.intent(p['intent_id'],subject);proof=p['provenance']
            from app.uat2.revision_baskets import REVISION_PROVENANCE
            fields=PROVENANCE+REVISION_PROVENANCE if p.get('schema')==2 else PROVENANCE
            require(type(proof) is dict and set(proof)==set(fields) and proof['owner_id']==subject
                and proof['module_version']==intent.module_version and type(p['schema']) is int and p['schema'] in {1,2} and p['simulation'] is True
                and p['request_digest']==intent.request_digest and p['order_hash']==digest(intent.payload_json)
                and p['scenario'] in {'filled','partial','after_acceptance','before_acceptance'}
                and p['digest']==digest({k:v for k,v in p.items() if k!='digest'})
                and intent.risk_json.get('application_provenance_hash')==digest(p))
            flow=self.resource(AutoRebalanceWorkflow,proof['workflow_id'],subject,'user_id')
            require(proof['source_hash']==flow.execution_json['source_hash']
                and proof['plan_hash']==flow.execution_json['plan_hash']
                and intent.operation_key_digest==digest({'operation':'confirmed_order','key':'linked-analysis:'+digest(proof)}))
            if p['schema']==2:
                from app.domains.runs.models import AutoRebalanceWorkflowStage
                from app.domains.runs.analysis_workflows.plan_revisions import ALGORITHM
                stage=self.db.scalar(select(AutoRebalanceWorkflowStage).where(AutoRebalanceWorkflowStage.workflow_id==flow.id,AutoRebalanceWorkflowStage.stage=='actionables'))
                revisions=stage.checkpoint_json.get('advisory_revisions',[]) if stage else []
                require(type(revisions) is list and len(revisions)<=20 and hash_value(proof['revision_version']) and hash_value(proof['revision_math_hash']) and hash_value(proof['revision_risk_basis_hash']))
                found=[item for item in revisions if type(item) is dict and type(item.get('record')) is dict and item['record'].get('version')==proof['revision_version']]
                require(len(found)==1);entry=found[0];record=entry['record']
                require(entry.get('receipt_hash')==digest(record) and record.get('algorithm')==ALGORITHM and record.get('orders_authorized') is False
                    and record.get('math_hash')==proof['revision_math_hash'] and record.get('owner_id')==subject and record.get('workflow_id')==flow.id
                    and record.get('source_hash')==proof['source_hash'] and record.get('plan_hash')==proof['plan_hash'] and record.get('result_hash')==proof['actionables_result_hash'])
            return {'kind':'analysis_basket_provenance','intent_id':intent.id,'provenance':proof,'scenario':p['scenario']}
        if topic==VENUE:
            reference=p['receipt']['client_reference']
            rows=self.db.execute(select(OrderLeg,OrderIntent).join(OrderIntent,OrderLeg.intent_id==OrderIntent.id)
                .where(OrderLeg.client_reference==reference,OrderIntent.owner_id==subject).limit(2)).all()
            require(len(rows)==1);leg,intent=rows[0]
            self.intent(intent.id,subject)
            require(leg.payload_digest==digest(p['leg']) and leg.client_reference==reference
                and type(leg.position) is int and 0<=leg.position<len(intent.payload_json['legs'])
                and intent.payload_json['legs'][leg.position]==p['leg'])
            value=JournalBrokerFake(self.db.get_bind(),venue_binding(intent))._read(
                SimpleNamespace(topic=topic,payload=p),reference,venue_binding(intent))
            return {'kind':'synthetic_venue_evidence','intent_id':intent.id,'client_reference':reference,**value}
        if topic==ARTIFACT:
            require(p.get('schema_version')==1 and p.get('kind')=='export'
                and p.get('destination')=='local:owned-analysis-download' and type(p.get('content')) is dict)
            content=p['content'];expected={'schema_version','simulation_only','owner_id','workflow_id','module_id',
                'module_version','source_hash','plan_hash','actionables_result_hash','recommendations','orders_authorized'}
            require(set(content)==expected and content['owner_id']==subject and content['simulation_only'] is True
                and content['orders_authorized'] is False and p['content_hash']==digest(content))
            flow=self.resource(AutoRebalanceWorkflow,content['workflow_id'],subject,'user_id')
            require((content['module_id'],content['module_version'],content['source_hash'],content['plan_hash'])==
                (flow.module_id,flow.module_version,flow.execution_json['source_hash'],flow.execution_json['plan_hash']))
            require(p['request_hash']==digest({k:v for k,v in p.items() if k not in {'state','expires_at','request_hash','sink_receipt','receipt_hash'}})
                and p['receipt_hash']==digest({k:v for k,v in p.items() if k not in {'state','sink_receipt','receipt_hash'}}))
            return {'kind':'private_analysis_artifact','state':p['state'],'expires_at':p['expires_at'],'content':content}
        if topic==MONITOR:
            report=MonitorDispatch._report(subject,{key:p[key] for key in FIELDS})
            require(p['synthetic_sink'] is True and p['state'] in {'pending','recorded'})
            if p['state']=='recorded':require(p['receipt']==digest(report))
            # No raw provenance or extra payload fields are copied into export.
            return {'kind':'local_operational_observation','report':report,'state':p['state'],'external_delivery':False}
        raise BoundaryDenied('NATIVE_ACCOUNT_TOPIC_UNSUPPORTED')

    def export(self,subject):
        self.scope.validate(self.db,subject);owner(self.db,subject,verified=True)
        dialect=self.db.get_bind().dialect.name
        if dialect=='postgresql' and self.db.connection().get_isolation_level() not in {'REPEATABLE READ','SERIALIZABLE'}:
            raise BoundaryDenied('ACCOUNT_SNAPSHOT_ISOLATION_REQUIRED')
        owned_venue=exists(select(1).select_from(OrderLeg).join(OrderIntent,OrderLeg.intent_id==OrderIntent.id)
            .where(OrderIntent.owner_id==subject,OrderLeg.client_reference==OutboxMessage.payload['receipt']['client_reference'].as_string()))
        predicate=((OutboxMessage.topic==VENUE)&owned_venue)|((OutboxMessage.topic.in_(TOPICS-{VENUE}))&
            (OutboxMessage.payload['owner_id'].as_integer()==subject))
        length=func.octet_length(cast(OutboxMessage.payload,Text)) if dialect=='postgresql' else func.length(cast(OutboxMessage.payload,LargeBinary))
        oversized=length>MAX_VALUE
        payload=case((oversized,None),else_=cast(OutboxMessage.payload,Text))
        statement=select(OutboxMessage.id,OutboxMessage.topic,payload,oversized).where(predicate)
        items=[];used=0
        try:
            with self.db.execute(statement.limit(MAX_ROWS+1).execution_options(
                    stream_results=True,yield_per=1,max_row_buffer=1)) as rows:
                for identifier,topic,raw,too_large in rows:
                    if too_large or len(items)>=MAX_ROWS:raise BoundaryDenied('NATIVE_ACCOUNT_EXPORT_BOUND')
                    data=self.project(identifier,topic,_value(_json_value(raw,MAX_VALUE)),subject)
                    item={'id':str(identifier),'topic':topic,'data':clean(data)}
                    used+=len(json.dumps(item,allow_nan=False).encode())
                    if used>MAX_BYTES:raise BoundaryDenied('NATIVE_ACCOUNT_EXPORT_BOUND')
                    items.append(item)
        except (KeyError,TypeError,ValueError,AttributeError) as error:
            if isinstance(error,BoundaryDenied):raise
            raise BoundaryDenied('NATIVE_ACCOUNT_EVIDENCE_BINDING_REQUIRED') from None
        result={'owner_id':subject,'simulation_only':True,'scope':'typed_native_outbox_evidence',
            'items':sorted(items,key=lambda item:(item['topic'],item['id'])),'covered_topics':sorted(TOPICS),
            'raw_payload_dump':False,'complete_account_export':False,'complete_account_erasure':False,
            'uncovered_stores':['other_outbox_contracts','shared_opaque_blobs','files','cache','identity','backups']}
        return {**result,'content_hash':digest(result)}
