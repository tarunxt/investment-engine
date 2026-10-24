"""Atomic, immutable acceptance of a reviewed synthetic shortlist.

Raw provenance is stored privately but never enters a model prompt. No new store,
discovery provider, financial authority or automatic order path is introduced.
"""
from .contracts import WorkflowDenied,digest
from .candidate_preview import preview
from .candidate_catalogue import CATALOGUE

MAX_UNIVERSE=200  # Existing governed output/source bound, never truncate to it.
VERSION='synthetic-shortlist-v1'


def prepare(owner,portfolio,source,request):
    from app.domains.ai_limits.projection import projection
    module='zerodha_rebalance' if portfolio=='india' else 'indmoney_us'
    facts=projection(source,owner=owner,module=module)
    if not isinstance(request,dict) or set(request)!={'raw_text','format','preview_hash','setup_hash'}:
        raise WorkflowDenied('Exact reviewed shortlist contract required')
    document=preview(request['raw_text'],request['format'],portfolio,catalogue=CATALOGUE,
        holdings=facts['holdings'],owner=owner,source_hash=digest(source))
    if document['preview_hash']!=request['preview_hash']:raise WorkflowDenied('Shortlist preview changed')
    body,hash=from_preview(document,holdings=facts['holdings'])
    if hash!=request['setup_hash']:raise WorkflowDenied('Accepted shortlist version changed')
    return body,hash


def from_preview(document,*,holdings):
    if document['counts']['rejected_rows'] or document['counts']['unresolved_rows']:
        raise WorkflowDenied('Resolve every candidate row before acceptance; nothing was silently dropped')
    accepted=sorted({row['instrument_id'] for row in document['rows']})
    if not accepted or len(set(holdings)|set(accepted))>MAX_UNIVERSE:
        raise WorkflowDenied('Holdings plus shortlist exceed the 200-instrument governed bound; split explicitly, no batch policy is installed')
    body={'version':VERSION,'mode':'shortlist_only','owner_id':document['owner_id'],
        'portfolio':document['portfolio'],'source_hash':document['source_hash'],
        'catalogue_hash':document['catalogue_hash'],'parser_version':document['parser_version'],
        'format':document['format'],'raw_source':document['raw_source'],'rows':document['rows'],
        'preview_hash':document['preview_hash'],'accepted_instruments':accepted,
        'raw_rows':document['counts']['raw_rows'],'discovery_performed':False,'orders_authorized':False}
    return body,digest(body)


def verified(row):
    e=row.execution_json
    if 'research_setup' not in e and 'research_setup_hash' not in e:return None
    body=e.get('research_setup')
    if not isinstance(body,dict) or body.get('owner_id')!=row.user_id or body.get('portfolio')!=row.portfolio:
        raise WorkflowDenied('Owned frozen shortlist required')
    request={'raw_text':body.get('raw_source'),'format':body.get('format'),
        'preview_hash':body.get('preview_hash'),'setup_hash':e.get('research_setup_hash')}
    expected,hash=prepare(row.user_id,row.portfolio,e['source'],request)
    if body!=expected or digest(body)!=hash:raise WorkflowDenied('Frozen shortlist integrity changed')
    return body


def prompt_context(row):
    body=verified(row)
    return None if body is None else {'mode':'shortlist_only','setup_hash':row.execution_json['research_setup_hash'],
        'accepted_instruments':body['accepted_instruments'],'discovery_performed':False,
        'raw_provenance_excluded':True,'orders_authorized':False}


def required(row):
    body=verified(row)
    return set(body['accepted_instruments']) if body else set()
