"""Governed analysis -> immutable fake review; never approves or calls providers."""
from datetime import datetime, timezone
import os
from decimal import Decimal
from uuid import UUID, uuid5
from sqlalchemy import select,func
from app.domains.modules.lifecycle import current_sync, WorkIdentity
from app.domains.modules.registry import ModuleId
from app.domains.order_intents.contracts import OrderDenied, digest
from app.domains.order_intents.models import OrderIntent,OrderLeg
from app.domains.order_intents.service import Orders, MODULE
from app.domains.order_intents.execution_fake import MarketDataFake
from app.domains.runs.analysis_workflows.synthetic_composition import SyntheticAnalysis
from app.infrastructure.database.outbox.models import OutboxMessage
from app.uat2.policy_bindings import binding_for

TOPIC = 'uat2.analysis_basket.v1'
NAMESPACE = UUID('4339df03-e109-433c-a708-846139cc38dc')
PROVENANCE = ('workflow_id', 'owner_id', 'module_version', 'source_hash', 'plan_hash', 'actionables_result_hash')


def derived(evidence):
    if evidence['module_id'] != MODULE or evidence['orders_authorized'] is not False or evidence['simulation'] is not True:
        raise OrderDenied('SYNTHETIC_INDIA_ANALYSIS_REQUIRED')
    legs = []
    for item in evidence['recommendations']:
        if item['action'] == 'hold': continue
        if item['instrument'] != 'NSE:SYNTHETIC0' or item['action'] != 'trim':
            raise OrderDenied('SYNTHETIC_TRIM_SUBSET_REQUIRED')
        quantity = Decimal(item['current_units']) - Decimal(item['final_units'])
        if not quantity.is_finite() or quantity <= 0 or quantity > 3 or quantity != quantity.to_integral_value():
            raise OrderDenied('EXACT_SYNTHETIC_QUANTITY_REQUIRED')
        legs.append(dict(exchange='NSE', symbol='SYNTHETIC0', side='SELL', quantity=int(quantity),
            limit_price='10.01', product='CNC', order_type='LIMIT'))
    if len(legs) != 1: raise OrderDenied('ONE_EXACT_SYNTHETIC_TRIM_REQUIRED')
    return {'sequencing': 'listed', 'legs': legs}


class SyntheticOrders:
    def __init__(self, analysis):
        if type(analysis) is not SyntheticAnalysis: raise OrderDenied('EXACT_SYNTHETIC_ANALYSIS_REQUIRED')
        self.analysis = analysis
        self.scenario = os.getenv('UAT2_SIMULATION_SCENARIO', 'filled')
        if self.scenario not in {'filled','partial','after_acceptance','before_acceptance'}:
            raise OrderDenied('KNOWN_SERVER_SIMULATION_SCENARIO_REQUIRED')

    def policy(self, db, identity):
        binding = binding_for(db)
        if binding is None or binding.scope != self.analysis.scope:
            raise OrderDenied('MATCHING_SIMULATION_SESSION_REQUIRED')
        facts = binding.facts(identity.owner_id, ModuleId.ZERODHA_REBALANCE)
        if not facts.execution_capability or facts.connection != 'ready':
            raise OrderDenied('CURRENT_KEYLESS_FAKE_CONNECTION_REQUIRED')
        # This authorizes fake service checks only. Orders.approve separately
        # consumes the authenticated request-local exact confirmation capability.
        current_sync(db, identity, capability='execute', boundary='side_effect',
            facts=facts.model_copy(update={'action_confirmed': True}))

    def risk(self, db, identity, order, connection, now):
        self.analysis.scope.validate(db, identity.owner_id)
        expected = {'sequencing': 'listed', 'legs': [dict(exchange='NSE', symbol='SYNTHETIC0', side=order['legs'][0]['side'],
            quantity=order['legs'][0]['quantity'], limit_price='10.01', product='CNC', order_type='LIMIT')]}
        if (order != expected or type(order['legs'][0]['quantity']) is not int
                or order['legs'][0]['side'] not in {'BUY','SELL'} or not 1 <= order['legs'][0]['quantity'] <= 3 or connection.credential_ref is not None
                or not (connection.provider_account_id or '').startswith('FAKE')):
            raise OrderDenied('FIXED_SYNTHETIC_CATALOGUE_REQUIRED')
        return {'allowed': True, 'synthetic': True, 'owner': identity.owner_id,
            'account': connection.provider_account_id, 'payload_hash': digest(order), 'max_order_quantity': 3, 'simulation_scenario': self.scenario}

    def provenance(self, db, row, now, *, current=True):
        self.analysis.scope.validate(db, row.owner_id)
        message = db.get(OutboxMessage, uuid5(NAMESPACE, row.id), populate_existing=True)
        value = message.payload if message is not None else None
        if (message is None or message.topic != TOPIC or type(value) is not dict
                or set(value) != {'schema', 'simulation', 'intent_id', 'owner_id', 'provenance', 'request_digest', 'order_hash', 'scenario', 'digest'}
                or type(value['schema']) is not int or value['schema'] not in {1,2} or value['simulation'] is not True
                or value['scenario'] not in {'filled','partial','after_acceptance','before_acceptance'}
                or current and value['scenario'] != self.scenario
                or value['intent_id'] != row.id or value['owner_id'] != row.owner_id
                or value['request_digest'] != row.request_digest or value['order_hash'] != digest(row.payload_json)
                or digest({k: v for k, v in value.items() if k != 'digest'}) != value['digest']):
            raise OrderDenied('IMMUTABLE_ANALYSIS_BASKET_RECEIPT_REQUIRED')
        if row.state != 'draft' and (type(row.risk_json) is not dict or row.risk_json.get('application_provenance_hash') != digest(value)):
            raise OrderDenied('REVIEWED_ANALYSIS_PROVENANCE_CHANGED')
        provenance = value['provenance']
        from .revision_baskets import REVISION_PROVENANCE
        fields=PROVENANCE+REVISION_PROVENANCE if value['schema']==2 else PROVENANCE
        if (type(provenance) is not dict or set(provenance) != set(fields)
                or provenance['owner_id'] != row.owner_id or provenance['module_version'] != row.module_version
                or row.operation_key_digest != digest({'operation': 'confirmed_order', 'key': 'linked-analysis:' + digest(provenance)})):
            raise OrderDenied('ANALYSIS_BASKET_PROVENANCE_CHANGED')
        if current:
            try: evidence = self.analysis.completed_analysis(db, row.owner_id, provenance['workflow_id'], now=now)
            except (KeyError, TypeError, ValueError): raise OrderDenied('GOVERNED_ANALYSIS_RECEIPT_INVALID') from None
            expected_order=derived(evidence) if value['schema']==1 else None
            if value['schema']==2:
                from .revision_baskets import assess,selected,derived as revised_order
                if row.state in {'draft','validated','awaiting_approval','approved'}:
                    _,plan,record,expected_order,assessment=assess(self,db,row.owner_id,provenance['workflow_id'],provenance['revision_version'],now=now)
                    if assessment['risk_basis_hash']!=provenance['revision_risk_basis_hash']:raise OrderDenied('REVISION_RISK_OBSERVATION_CHANGED')
                else:
                    _,plan,record=selected(db,self.analysis,row.owner_id,provenance['workflow_id'],provenance['revision_version'],latest=False)
                    expected_order=revised_order(plan)
                if record['math_hash']!=provenance['revision_math_hash']:raise OrderDenied('REVISION_MATH_RECEIPT_CHANGED')
            if {k: evidence[k] for k in PROVENANCE} != {k:provenance[k] for k in PROVENANCE} or expected_order != row.payload_json:
                raise OrderDenied('CURRENT_GOVERNED_ANALYSIS_REQUIRED')
        return value

    def prepare(self, db, owner, workflow_id, *, now=None,revision_version=None):
        now = now or datetime.now(timezone.utc)
        evidence = self.analysis.completed_analysis(db, owner, workflow_id, now=now)
        order = derived(evidence) if revision_version is None else None
        provenance = {k: evidence[k] for k in PROVENANCE}
        schema=1
        if revision_version is not None:
            from .revision_baskets import assess
            evidence,plan,record,order,assessment=assess(self,db,owner,workflow_id,revision_version,now=now)
            provenance={**provenance,'revision_version':revision_version,'revision_math_hash':record['math_hash'],'revision_risk_basis_hash':assessment['risk_basis_hash']};schema=2
        key = 'linked-analysis:' + digest(provenance)
        old = db.scalar(select(OrderIntent).where(OrderIntent.owner_id == owner,
            OrderIntent.operation_key_digest == digest({'operation': 'confirmed_order', 'key': key})))
        if old is not None:
            self.provenance(db, old, now)
            return old  # no state reset, reapproval or reopening
        service = Orders(db, policy=self.policy, risk=self.risk, provenance=self.provenance)
        connection = evidence['source']['connection']
        row = service.create(WorkIdentity(owner, MODULE, evidence['module_version']), key, connection['id'], order, now=now)
        if (row.connection_version, row.account_id, row.app_mode) != (connection['version'], connection['account'], connection['mode']):
            raise OrderDenied('ANALYSIS_CONNECTION_CHANGED')
        value = {'schema': schema, 'simulation': True, 'intent_id': row.id, 'owner_id': owner,
            'provenance': provenance, 'request_digest': row.request_digest, 'order_hash': digest(order), 'scenario':self.scenario}
        db.add(OutboxMessage(id=uuid5(NAMESPACE, row.id), topic=TOPIC, payload={**value, 'digest': digest(value)}))
        db.flush()
        service.validate(owner, row.id, now=now)
        service.review(owner, row.id, now=now)
        return row

    def holdings(self, db, row):
        return self.balances(db,row)[0]

    def balances(self,db,row):
        records=list(db.execute(select(OrderLeg,OrderIntent).join(OrderIntent,OrderLeg.intent_id==OrderIntent.id).where(OrderIntent.owner_id==row.owner_id,OrderIntent.account_id==row.account_id).limit(1001)))
        if len(records)>1000:raise OrderDenied('SYNTHETIC_POSITION_LEDGER_UNAVAILABLE')
        holdings=3;funds=Decimal('100000.00')
        for leg,intent in records:
            try:
                value=intent.payload_json['legs'][leg.position];quantity=leg.filled_quantity
                if digest(value)!=leg.payload_digest or type(quantity) is not int or not 0<=quantity<=value['quantity'] or value['symbol']!='SYNTHETIC0' or value['exchange']!='NSE' or value['side'] not in {'BUY','SELL'} or value['limit_price']!='10.01':raise ValueError()
                signed=quantity if value['side']=='BUY' else -quantity
                holdings+=signed;funds-=Decimal('10.01')*signed
            except (KeyError,IndexError,TypeError,ValueError):raise OrderDenied('SYNTHETIC_POSITION_LEDGER_UNAVAILABLE') from None
        if not 0<=holdings<=6 or funds<0:
            raise OrderDenied('SYNTHETIC_POSITION_LEDGER_UNAVAILABLE')
        return holdings,funds

    def market(self, db, row, now):
        # Server-fixed fake observation, independent of model/request prices.
        holdings,funds=self.balances(db,row)
        return MarketDataFake(dict(owner_id=row.owner_id, account_id=row.account_id,
            connection_id=row.connection_id, connection_version=row.connection_version, app_mode=row.app_mode,
            source='synthetic_authoritative', as_of=now, funds=str(funds), exposure=str(Decimal('10.01')*holdings),
            instruments={'NSE:SYNTHETIC0': dict(tradable=True, market_open=True, product='CNC',
                quote='10.01', tick='0.01', lot=1, lower='1.00', upper='100000.00', holdings=holdings)}))
