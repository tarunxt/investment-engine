"""Captured holding identity for read-only event drill-down; never order authority."""
from decimal import Decimal
import re
from uuid import UUID
from app.domains.ai_limits.projection import projection,holdings
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.runs.analysis_workflows.contracts import digest

TARGET_LIMIT=200

def project_holdings(source,owner,portfolio,rows):
    if not isinstance(source,dict) or portfolio not in {'india','indmoney_us'} or source.get('portfolio',portfolio)!=portfolio:raise BoundaryDenied('FROZEN_PORTFOLIO_REQUIRED')
    module='zerodha_rebalance' if portfolio=='india' else 'indmoney_us'
    facts=projection(source,owner=owner,module=module)
    instruments={key for key,units in facts['holdings'].items() if Decimal(units)>0}
    indices=[index for index,row in enumerate(rows) if str(row.get('Exchange','')).strip().upper()+':'+str(row.get('Stock Symbol','')).strip().upper() in instruments]
    source_hash=digest(source);identifier=None;version=None
    if portfolio=='india':
        candidate=source.get('source_receipt_id')
        try:
            if isinstance(candidate,str) and str(UUID(candidate))==candidate:identifier=candidate;version=source_hash
        except ValueError:pass
    else:
        candidate=source.get('snapshot_id');candidate_version=source.get('content_hash')
        if type(candidate) is int and candidate>0 and len(str(candidate))<=12 and isinstance(candidate_version,str) and re.fullmatch('[a-f0-9]{64}',candidate_version):identifier=str(candidate);version=candidate_version
    keys={}
    for index,row in enumerate(source['holdings']):
        instrument=next(iter(holdings([row],facts['currency'],module)))
        if instrument not in instruments:continue
        symbol=row['tradingsymbol'] if portfolio=='india' else row['symbol']
        exchange=row['exchange'] if portfolio=='india' else ''
        keys[instrument]=f"{facts['currency']}:{exchange}:{symbol}:{index}"
    targets=[]
    if identifier is not None:
        for index in indices[:TARGET_LIMIT]:
            row=rows[index];instrument=str(row.get('Exchange','')).strip().upper()+':'+str(row.get('Stock Symbol','')).strip().upper()
            targets.append({'row_index':index,'owner_id':owner,'portfolio':portfolio,'instrument':instrument,
                'source_id':identifier,'source_version':version,'source_hash':source_hash,
                'stock_key':keys[instrument],'captured_at':source['captured_at']})
    return {'available':True,'row_indices':indices,'source_hash':source_hash,'captured_at':source['captured_at'],
        'notice':'Exact canonical captured market/symbol membership with positive recorded units only; US is the recorded broad US market, not an inferred listing exchange. Not live broker holdings.',
        'targets':targets,'targets_truncated':identifier is not None and len(indices)>TARGET_LIMIT,
        'target_notice':'Exact saved holding links are bounded to200 matched event rows; no latest source is substituted.' if identifier is not None else 'Exact holding drawer identity is not established for this source format; no current or latest source is substituted.'}
