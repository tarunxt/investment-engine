"""Deterministic manual-import validation. No market/network/FX lookup or repairs."""
import csv
import hashlib
import io
import json
import re
from datetime import datetime, timezone, timedelta
from decimal import Decimal, InvalidOperation, localcontext
from app.domains.indmoney_us.numeric import (ARITHMETIC_PRECISION,decimal_value,storage_number,decimal_sum,stored_difference,derived_percent,safe_numbers)

from app.domains.indmoney_us.service import IndMoneyUsPortfolioService
from app.domains.indmoney_us.snapshot_validation import validate_holdings_snapshot
from app.shared.exceptions import ValidationException

PARSER_VERSION = 'indmoney-manual-3'
CSV_COLUMNS = ['symbol','company_name','currency','quantity','market_price','invested_value','current_value','total_pnl','total_pnl_percent']
CSV_TEMPLATE = ','.join(CSV_COLUMNS)+'\nUATA,Synthetic Alpha,USD,2,55,100,110,10,10\n'
NOISE = {'reports','report','transactions','explore','my us stocks','current holdings','stock name','market price','total pnl','invested (qty/price)'}
DECIMAL = re.compile(r'[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?\Z')
FINANCIAL_FIELDS = ('wallet_balance','current_value','invested_value','day_return_value','day_return_percent','total_return_value','total_return_percent')


def utc(value):
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def number(value):
    value = value.strip()
    if not value: return None
    if not DECIMAL.fullmatch(value): raise ValueError('Malformed finite decimal number')
    try: result = Decimal(value.replace(',',''))
    except InvalidOperation: raise ValueError('Malformed number') from None
    return storage_number(result)


def content_digest(data):
    """Bind all financial/provenance fields; acceptance timestamps/status are separate."""
    keys = [*FINANCIAL_FIELDS,'raw_text','snapshot_date','captured_at','source','holdings','market_indices','reported_holdings_count','import_provenance','supersedes_id','holdings_count','parse_status','parse_warnings','indices_count','dashboard_top_holdings']
    def encode(value):
        if isinstance(value,datetime):return utc(value).isoformat()
        if hasattr(value,'isoformat'): return value.isoformat()
        raise TypeError(type(value).__name__)
    try:payload=json.dumps({k:data.get(k) for k in keys},sort_keys=True,separators=(',',':'),default=encode,allow_nan=False)
    except ValueError:raise ValidationException('Nonfinite snapshot content cannot be accepted; create a corrected preview.') from None
    return hashlib.sha256(payload.encode()).hexdigest()


def opposite_signs(left,right):
    return left is not None and right is not None and left!=0 and right!=0 and (left<0)!=(right<0)


def validate_financial_data(data):
    with localcontext() as context:
        context.prec=ARITHMETIC_PRECISION
        return _validate_financial_data(data)


def _validate_financial_data(data):
    errors=[]
    # No NaN/Infinity or malformed numeric value may reach comparisons or hashes.
    unsafe=[];safe_numbers(data,unsafe)
    if unsafe:return unsafe
    try:
        for value in [*(data.get(key) for key in FINANCIAL_FIELDS),*(h.get(key) for h in data['holdings'] for key in ('quantity','market_price','average_price','current_value','invested_value','total_pnl','total_pnl_percent'))]:
            if value is not None:storage_number(value)
    except ValueError as error:return [str(error)]
    def dec(value):return decimal_value(value) if value is not None else None
    def threshold(value):return Decimal(value)
    for field in ('current_value','invested_value'):
        if data.get(field) is None or data[field]<0:errors.append(f'Portfolio {field} is missing or negative; no source value was invented.')
    try:validate_holdings_snapshot(data)
    except ValidationException as exc:errors.append(exc.message)
    names={}
    for holding in data['holdings']:
        folded=str(holding.get('company_name') or '').strip().casefold()
        if folded in names and names[folded]!=holding.get('symbol'):errors.append('One company name maps to multiple symbols; clarify the share class/name in the CSV.')
        names[folded]=holding.get('symbol')
        symbol=str(holding.get('symbol') or '')
        name=str(holding.get('company_name') or '').strip()
        if not re.fullmatch(r'[A-Z][A-Z0-9.-]{0,9}',symbol) or name.casefold() in NOISE or not name or name==symbol:
            errors.append('Symbol/name mapping is ambiguous; supply the full company name in the CSV template.')
        current,invested,pnl,percent=(dec(holding.get(key)) for key in ('current_value','invested_value','total_pnl','total_pnl_percent'))
        for key,value in [('current value',current),('invested value',invested)]:
            if value is None or value<0:errors.append(f'{symbol}: {key} is missing or negative.')
        delta=current-invested if current is not None and invested is not None else None
        if delta is not None and pnl is not None:
            if opposite_signs(delta,pnl):errors.append(f'{symbol}: source P&L sign contradicts current value minus cost.')
            if abs(delta-pnl)>threshold('.02'):errors.append(f'{symbol}: cost/current value/P&L do not reconcile.')
        effective_pnl=pnl if pnl is not None else delta
        # Sign is an invariant BEFORE any display/rounding tolerance.
        if opposite_signs(effective_pnl,percent):errors.append(f'{symbol}: nonzero return signs disagree.')
        if invested is not None and effective_pnl is not None and percent is not None:
            if invested<=0 or abs(effective_pnl/invested*100-percent)>threshold('.15'):
                errors.append(f'{symbol}: total-return percentage has a different sign or denominator.')
        quantity,price=dec(holding.get('quantity')),dec(holding.get('market_price'))
        if quantity is not None and price is not None and (price<0 or (current is not None and abs(quantity*price-current)>max(threshold('.03'),abs(current)*threshold('.001')))):
            errors.append(f'{symbol}: quantity × quote differs from current value; quote may be from a different period.')
    for field in ('current_value','invested_value'):
        exact=decimal_sum([h.get(field) for h in data['holdings']])
        if exact is not None:
            try:storage_number(exact)
            except ValueError:errors.append(f'Aggregate {field} cannot be stored faithfully; no rounding permitted.')
            if data.get(field) is not None and abs(dec(data[field])-exact)>threshold('.03'):errors.append(f'Summary {field} does not reconcile with the holdings.')
    value,percent=dec(data.get('day_return_value')),dec(data.get('day_return_percent'))
    if opposite_signs(value,percent):errors.append('Daily dollars/percentage disagree: source periods or parsing are ambiguous. No sign was repaired.')
    if value is not None and percent is not None and data.get('current_value') is not None:
        basis=dec(data['current_value'])-value
        if basis<=0 or abs(value/basis*100-percent)>threshold('.15'):errors.append('Daily return denominator/period cannot be reconciled; cash flows or different periods may be involved.')
    total,cost,current,percent=(dec(data.get(key)) for key in ('total_return_value','invested_value','current_value','total_return_percent'))
    delta=current-cost if current is not None and cost is not None else None
    if total is not None and delta is not None:
        if opposite_signs(delta,total):errors.append('Summary total-return sign contradicts current value minus cost.')
        if abs(delta-total)>threshold('.03'):errors.append('Summary total returns do not reconcile.')
    effective_total=total if total is not None else delta
    if opposite_signs(effective_total,percent):errors.append('Summary nonzero return signs disagree.')
    if effective_total is not None and percent is not None and (cost is None or cost<=0 or abs(effective_total/cost*100-percent)>threshold('.15')):errors.append('Summary total-return denominator/sign is ambiguous.')
    return list(dict.fromkeys(errors))


def parse_import(request, *, now=None):
    now=now or datetime.now(timezone.utc)
    captured=utc(request.captured_at)
    errors=[];warnings=[];exact_aggregates={}
    if captured>now+timedelta(minutes=5): errors.append('As-of time is in the future.')
    if now-captured>timedelta(hours=48): warnings.append('Stale snapshot: older than 48 hours; recommendations are blocked until a current import is accepted.')
    if request.currency!='USD':errors.append('Only explicit USD imports are supported; no implicit FX conversion.')
    if request.format=='csv':
        data=IndMoneyUsPortfolioService().parse_snapshot('',captured_at=captured,source='manual_csv')
        holdings=[]
        try:
            reader=csv.DictReader(io.StringIO(request.raw_text),strict=True)
            if reader.fieldnames!=CSV_COLUMNS:raise ValueError('CSV headers must exactly match the stable template.')
            for row in reader:
                if None in row or any(v is None for v in row.values()):raise ValueError('CSV has extra/missing fields; quote names containing commas.')
                if row['currency']!='USD':errors.append('Mixed/unsupported currency in CSV. No FX conversion performed.')
                holding={'symbol':row['symbol'].strip().upper(),'company_name':row['company_name'].strip(),**{k:number(row[k]) for k in CSV_COLUMNS[3:]}}
                if holding['market_price'] is None:warnings.append('Missing quote remains missing; supplied holding value is used.')
                holdings.append(holding)
                if len(holdings)>500:raise ValueError('At most 500 holdings per import.')
        except (ValueError,csv.Error) as exc:errors.append(str(exc))
        data.update(holdings=holdings,holdings_count=len(holdings),reported_holdings_count=len(holdings),parse_status='parsed' if holdings else 'unparsed',parse_warnings=[])
        for key in ('current_value','invested_value'):
            exact=decimal_sum([holding.get(key) for holding in holdings])
            if exact is not None:exact_aggregates[key]=format(exact,'f')
            try:data[key]=storage_number(exact) if exact is not None else None
            except ValueError:
                data[key]=None;errors.append(f'Aggregate {key} cannot be stored faithfully; no rounding permitted.')
        try:
            data['total_return_value']=stored_difference(data['current_value'],data['invested_value'])
            data['total_return_percent']=derived_percent(data['total_return_value'],data['invested_value'])
        except (ValueError,InvalidOperation):
            data['total_return_value']=data['total_return_percent']=None
            errors.append('Derived portfolio returns exceed supported storage; corrected source required.')
    else:
        data=IndMoneyUsPortfolioService().parse_snapshot(request.raw_text,captured_at=captured)
        if '$' not in request.raw_text and not re.search(r'\bUSD\b',request.raw_text):errors.append('Pasted currency is unconfirmed; use the explicit USD CSV template.')
        if any(marker in request.raw_text for marker in ('₹','€','£')) or re.search(r'\b(?:INR|EUR|GBP)\b',request.raw_text):errors.append('Mixed/unsupported currency in pasted source. Use the explicit USD CSV template.')
        # A substring parser must never silently accept broken number/grouping text.
        for line in request.raw_text.splitlines():
            if re.fullmatch(r'[+-]?[\d,.\s]+%?',line.strip()):
                try:number(line.strip().removesuffix('%'))
                except ValueError:errors.append('Malformed numeric field in pasted source.')
            if re.search(r'\b(?:nan|infinity|inf)\b',line,re.I):errors.append('Nonfinite value in pasted source.')
            for token in re.findall(r'[$₹€£]\s*([^\s()%]+)',line):
                try:number(token)
                except ValueError:errors.append('Malformed currency amount in pasted source; use the CSV template.')
            if any(mark in line.lower() for mark in ('$', '%','qty','avg')):
                for token in re.findall(r'[+-]?\d[\d,.]*',line):
                    try:number(token)
                    except ValueError:errors.append('Malformed or ambiguous number in pasted source; use the CSV template.')
        warnings.extend(data['parse_warnings'])
        if data.get('day_return_value') is not None or data.get('day_return_percent') is not None:
            if request.day_return_period!='1d_same_asof':errors.append('Daily return period is unconfirmed; confirm both values cover the same day ending at the as-of time, or correct the source.')
        for holding in data['holdings']:
            if holding.get('reported_total_pnl_percent') is not None and holding.get('total_pnl_percent')!=holding['reported_total_pnl_percent']:
                errors.append('A holding percentage sign was inferred by the legacy parser; confirm/correct it using CSV.')
    data['raw_text']=request.raw_text
    data=safe_numbers(data,errors)
    errors.extend(validate_financial_data(data))
    warnings.extend('Derived '+','.join(h['derived_fields'])+' for '+h['symbol']+' using documented quantity/price/cost arithmetic.' for h in data['holdings'] if h.get('derived_fields'))
    if data.get('day_return_value') is None:warnings.append('Daily return is missing, not zero.')
    provenance={'parser_version':PARSER_VERSION,'arithmetic':'decimal-400; cash stored only on exact Float/JSON roundtrip','derived_percentage_rounding':'8 decimal places, half even','exact_aggregates':exact_aggregates,'source_hash':hashlib.sha256(request.raw_text.encode()).hexdigest(),'currency':request.currency,'as_of':captured.isoformat(),'summary_basis':'sum of complete explicit CSV rows' if request.format=='csv' else 'reported pasted summary','fx':{'conversion':'none','source_currency':request.currency,'target_currency':'USD'},'symbol_mapping':'source-reported; no external symbol lookup','day_return_period':request.day_return_period,'errors':list(dict.fromkeys(errors)),'warnings':list(dict.fromkeys(warnings))}
    data.update(import_provenance=provenance,supersedes_id=request.supersedes_id,acceptance_state='quarantined' if errors else 'preview',parse_warnings=provenance['errors']+provenance['warnings'],parse_status='partial' if errors else 'parsed')
    from app.shared.portfolio_summary import build_persisted_portfolio_summary
    data['dashboard_top_holdings'],_=build_persisted_portfolio_summary(data['holdings'],total_value=data.get('current_value'))
    data['content_hash']=content_digest(data)
    data['import_key']=hashlib.sha256(json.dumps({'parser_version':PARSER_VERSION,'hash':provenance['source_hash'],'as_of':captured.isoformat(),'currency':request.currency,'period':request.day_return_period,'format':request.format,'supersedes_id':request.supersedes_id},sort_keys=True).encode()).hexdigest()
    return data


def require_source_provenance(data):
    provenance=data.get('import_provenance') or {}
    if provenance.get('currency')!='USD' or provenance.get('parser_version')!=PARSER_VERSION or provenance.get('source_hash')!=hashlib.sha256(data['raw_text'].encode()).hexdigest():
        raise ValidationException('Accepted source provenance is unsupported or inconsistent; create a new preview.')


def require_recommendation_snapshot(snapshot, *, now=None):
    if getattr(snapshot,'acceptance_state',None)!='accepted':raise ValidationException('Accept a validated manual import preview before analysis.')
    if (now or datetime.now(timezone.utc))-utc(snapshot.captured_at)>timedelta(hours=48):raise ValidationException('Snapshot is stale; accept a current manual import before analysis.')
    data={k:getattr(snapshot,k,None) for k in [*FINANCIAL_FIELDS,'raw_text','snapshot_date','captured_at','source','holdings','market_indices','reported_holdings_count','import_provenance','supersedes_id','holdings_count','parse_status','parse_warnings','indices_count','dashboard_top_holdings']}
    provenance=snapshot.import_provenance or {}
    require_source_provenance(data)
    if provenance.get('errors') or snapshot.content_hash!=content_digest(data):raise ValidationException('Accepted snapshot integrity failed; re-import for review.')
    errors=validate_financial_data(data)
    if errors:raise ValidationException('Accepted data failed validation.',{'errors':errors})
