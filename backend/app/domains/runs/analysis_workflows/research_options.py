"""Versioned synthetic discovery and user constraints; never live discovery.

Preview performs no I/O or enqueue. Accepted bytes join the existing durable
workflow; queued fake providers still execute every later research stage.
"""
from decimal import Decimal, localcontext
from .contracts import WorkflowDenied, digest
from .candidate_catalogue import CATALOGUE
from .candidate_preview import preview
from app.domains.ai_limits.projection import projection
from app.domains.order_intents.execution_risk import number

VERSION='synthetic-research-options-v1'
LIMIT=200
DEFAULTS={'horizon_days':365,'minimum_cash':'0','maximum_position_percent':'100','maximum_turnover_percent':'100'}
PRICES={'NSE:SYNTHETIC0':'10.01','US:UATA':'10','US:UATB':'20'}


class FakeDiscovery:
    """Explicit offline provider contract. Production adapters are not admitted."""
    version='offline-catalogue-discovery-v1'

    def discover(self, portfolio):
        return sorted(i for i in CATALOGUE if i.startswith('US:') == (portfolio=='indmoney_us'))


def constraints(value):
    if type(value) is not dict or set(value)!=set(DEFAULTS):raise WorkflowDenied('Complete research constraints required')
    if type(value['horizon_days']) is not int or not 1<=value['horizon_days']<=3650:raise WorkflowDenied('Horizon must be 1–3650 days; this is a research input, not suitability certification')
    result={'horizon_days':value['horizon_days']}
    try:
        for key in ('minimum_cash','maximum_position_percent','maximum_turnover_percent'):
            amount=number(value[key],zero=True)
            if key!='minimum_cash' and amount>100:raise WorkflowDenied('Percentage must be between zero and 100')
            result[key]=format(amount,'f')
    except (PermissionError,ValueError):raise WorkflowDenied('Finite nonnegative exact research constraints required') from None
    return result


def build(owner,portfolio,source,request,*,provider=None):
    if type(request) is not dict or set(request)!={'schema_version','mode','raw_text','format','constraints','accepted_universe_limit'} or type(request['schema_version']) is not int or request['schema_version']!=2:
        raise WorkflowDenied('Exact versioned research options required')
    mode=request['mode']
    if mode not in {'holdings_only','llm_discovery','shortlist_only','combined'} or type(request['accepted_universe_limit']) is not int or request['accepted_universe_limit']!=LIMIT:
        raise WorkflowDenied('Known mode and explicit 200-instrument limit acceptance required')
    policy=constraints(request['constraints']);module='zerodha_rebalance' if portfolio=='india' else 'indmoney_us'
    facts=projection(source,owner=owner,module=module)
    if not facts['holdings'] or not set(facts['holdings'])<=CATALOGUE:raise WorkflowDenied('Current owned synthetic holdings required')
    if request['format'] not in {'paste','csv'} or type(request['raw_text']) is not str or len(request['raw_text'])>100000:raise WorkflowDenied('Bounded paste/CSV required')
    shortlist=[];rows=[];raw=0
    if mode in {'shortlist_only','combined'}:
        document=preview(request['raw_text'],request['format'],portfolio,catalogue=CATALOGUE,holdings=facts['holdings'],owner=owner,source_hash=digest(source))
        if document['counts']['rejected_rows'] or document['counts']['unresolved_rows']:raise WorkflowDenied('Resolve all rejected or ambiguous rows before acceptance')
        shortlist=sorted({r['instrument_id'] for r in document['rows']});rows=document['rows'];raw=document['counts']['raw_rows']
        if not shortlist:raise WorkflowDenied('A resolved nonempty shortlist is required')
    elif request['raw_text'].strip():raise WorkflowDenied('Candidate text must be explicitly excluded or use shortlist/combined mode')
    discovered=[];receipt=None
    if mode in {'llm_discovery','combined'}:
        provider=provider or FakeDiscovery()
        if type(provider) is not FakeDiscovery:raise WorkflowDenied('Only the offline test discovery provider is installed')
        try:discovered=provider.discover(portfolio)
        except Exception:raise WorkflowDenied('Offline discovery failed; no universe accepted') from None
        if type(discovered) is not list or not discovered or len(discovered)>LIMIT or any(type(i) is not str or i not in CATALOGUE or i.startswith('US:')!=(portfolio=='indmoney_us') for i in discovered):raise WorkflowDenied('Discovery returned an invalid or incomplete canonical universe')
        receipt={'provider':'fake','version':provider.version,'raw_rows':len(discovered),'instruments':discovered,'live_provider_called':False}
        receipt['hash']=digest(receipt)
    accepted=sorted(set(shortlist)|set(discovered))
    if len(set(facts['holdings'])|set(accepted))>LIMIT:raise WorkflowDenied('Explicit batch policy required above 200 instruments; nothing truncated')
    return {'version':VERSION,'mode':mode,'owner_id':owner,'portfolio':portfolio,'source_hash':digest(source),
        'request':request,'accepted_instruments':accepted,'raw_rows':raw+len(discovered),'rows':rows,
        'discovery_performed':bool(discovered),'discovery_receipt':receipt,'constraints':policy,
        'planning_basis':{'source':'synthetic_planning_assumption','cash':'100000','prices':PRICES,'live_funds_verified':False},
        'coverage':{'shortlist_rows':raw,'discovery_rows':len(discovered),'unique_candidates':len(accepted),'holdings_overlap':len(set(accepted)&set(facts['holdings'])),'rejected':0,'deferred':0,'universe_limit':LIMIT},
        'simulation_only':True,'estimated_cost_usd':'0','orders_authorized':False}


def prepare(owner,portfolio,source,request):
    if type(request) is not dict or not {'preview_hash','setup_hash'}<=set(request):raise WorkflowDenied('Exact reviewed research preview required')
    body=build(owner,portfolio,source,{k:v for k,v in request.items() if k not in {'preview_hash','setup_hash'}})
    hash=digest(body)
    if request['preview_hash']!=hash or request['setup_hash']!=hash:raise WorkflowDenied('Research preview/source/constraints changed')
    return body,hash


def evaluate(source,options,recommendations):
    """Exact source-price planning estimates; execution uses fresh risk separately."""
    from app.domains.ai_limits.projection import projection
    facts=projection(source,owner=options['owner_id'],module='zerodha_rebalance' if options['portfolio']=='india' else 'indmoney_us')
    with localcontext() as ctx:
        ctx.prec=80
        cash=Decimal(options['planning_basis']['cash']);prices={k:Decimal(v) for k,v in options['planning_basis']['prices'].items()}
        before=sum((Decimal(units)*prices[key] for key,units in facts['holdings'].items()),Decimal(0));equity=cash+before;gross=Decimal(0);positions=[]
        for row in recommendations:
            instrument=row['instrument'];current=Decimal(facts['holdings'].get(instrument,'0'))
            try:final=number(row['final_units'],zero=True)
            except ValueError:raise WorkflowDenied('Bounded finite final units required') from None
            if instrument not in prices:raise WorkflowDenied('Planning price unavailable')
            change=(final-current)*prices[instrument];cash-=change;gross+=abs(change);positions.append(final*prices[instrument])
        policy=options['constraints'];turnover=gross/equity*100;concentration=max(positions,default=Decimal(0))/equity*100
        valid=cash>=Decimal(policy['minimum_cash']) and turnover<=Decimal(policy['maximum_turnover_percent']) and concentration<=Decimal(policy['maximum_position_percent'])
        return {'cash_before':options['planning_basis']['cash'],'cash_after':str(cash),'equity_basis':str(equity),'turnover_percent':str(turnover),'maximum_position_percent':str(concentration),'valid':valid,'simulation_only':True,'live_funds_verified':False}


def validate_output(row,document):
    options=row.execution_json.get('research_setup')
    if options and options.get('version')==VERSION:
        result=evaluate(row.execution_json['source'],options,document['recommendations'])
        if not result['valid']:raise WorkflowDenied('Research output violates reviewed cash, concentration or turnover constraints')
