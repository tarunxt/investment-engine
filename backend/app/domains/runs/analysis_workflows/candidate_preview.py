"""Bounded inert candidate preview. It cannot create/accept analysis or orders.

A caller supplies a trusted catalogue. Raw source text is retained as provenance,
but never becomes a prompt, URL fetch, instruction or authority.
"""
import csv
import io
import re
from .contracts import digest,WorkflowDenied

class CandidateInputError(WorkflowDenied):pass

VERSION='candidate-preview-1'
MAX_ROWS=1000
MAX_CHARS=100000

def preview(raw,format,portfolio,*,catalogue,holdings,owner,source_hash):
    if not isinstance(raw,str) or not raw.strip() or len(raw)>MAX_CHARS:raise CandidateInputError('Nonempty candidate text up to 100000 characters required; nothing was truncated')
    if format not in {'paste','csv'}:raise CandidateInputError('Paste or CSV required; URL ingestion is unavailable')
    market='NSE' if portfolio=='india' else 'US'
    currency='INR' if portfolio=='india' else 'USD'
    if format=='csv':
        try:
            reader=csv.DictReader(io.StringIO(raw),strict=True)
            if not reader.fieldnames or 'symbol' not in reader.fieldnames or len(reader.fieldnames)!=len(set(reader.fieldnames)) or not set(reader.fieldnames)<={'symbol','market','currency','instrument_id','company_name'}:
                raise CandidateInputError('CSV needs symbol and optional market,currency,instrument_id,company_name columns')
            rows=[dict(row) for row in reader if any(value for value in row.values())]
            if any(None in row for row in rows):raise CandidateInputError('CSV row has extra fields; nothing was accepted')
        except (csv.Error,TypeError):raise CandidateInputError('Malformed candidate CSV; no source row was accepted') from None
    else:rows=[{'symbol':line.strip()} for line in raw.splitlines() if line.strip()]
    if len(rows)>MAX_ROWS:raise CandidateInputError('Candidate preview limit is 1000 data rows; split explicitly, nothing was truncated')
    if not rows:raise CandidateInputError('No candidate data rows')
    result=[];unique=set();rejected=0;unresolved=0
    for index,row in enumerate(rows,1):
        symbol=str(row.get('symbol') or '').strip().upper();explicit=str(row.get('instrument_id') or '').strip().upper()
        row_market=str(row.get('market') or market).strip().upper();row_currency=str(row.get('currency') or currency).strip().upper()
        identifier=explicit or (symbol if ':' in symbol else row_market+':'+symbol)
        simple=identifier.split(':')[-1]
        valid=(set(row)<={'symbol','market','currency','instrument_id','company_name'} and re.fullmatch(r'[A-Z][A-Z0-9.-]{0,31}',simple) is not None and row_market==market and row_currency==currency and (not explicit or symbol in {explicit,explicit.split(':')[-1]}))
        matches=[value for value in catalogue if value==identifier and value.startswith(market+':')] if valid else []
        state='resolved' if len(matches)==1 else 'rejected' if not valid else 'unresolved'
        canonical=matches[0] if state=='resolved' else None
        duplicate=canonical in unique if canonical else False
        if canonical:unique.add(canonical)
        rejected+=state=='rejected';unresolved+=state=='unresolved'
        result.append({'row':index,'source':row,'state':state,'instrument_id':canonical,'duplicate':duplicate,'holdings_overlap':canonical in holdings if canonical else False,'reason':None if canonical else 'Unresolved or ambiguous canonical instrument; no market lookup or instruction was executed'})
    body={'schema_version':1,'parser_version':VERSION,'owner_id':owner,'portfolio':portfolio,'source_hash':source_hash,'format':format,'raw_source':raw,'rows':result,
        'counts':{'raw_rows':len(rows),'unique_candidates':len(unique),'rejected_rows':rejected,'unresolved_rows':unresolved,'analysed_candidates':0,'deferred_candidates':len(unique)},
        'count_definitions':{'raw_rows':'Nonempty data rows excluding a CSV header','unique_candidates':'Distinct resolved canonical IDs; duplicates retained in provenance','analysed_candidates':'Candidates actually analysed by this request: always zero','deferred_candidates':'Resolved unique candidates not submitted to analysis'},
        'accepted_for_analysis':False,'orders_authorized':False,'catalogue_scope':'documented synthetic instruments only','catalogue_hash':digest(sorted(catalogue)),'limits':{'max_rows':MAX_ROWS,'max_characters':MAX_CHARS,'truncated':False}}
    body['preview_hash']=digest(body)
    return body
