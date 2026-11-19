"""Fail closed on cross-scale technical levels for opt-in broker-anchored scans.

Historical/custom prompts are unchanged. Price-list midpoint estimates are recorded with their source values.
"""
from decimal import Decimal, localcontext
import json
import math
import re
from .output_contracts.document import encode_cell, parse_markdown


ANCHORS = re.compile(r'\[TECHNICAL_PRICE_ANCHORS_V1\]\s*(.*?)\s*\[/TECHNICAL_PRICE_ANCHORS_V1\]', re.S)


class MissingTechnicalListings(ValueError):
    def __init__(self, ids, accepted_count=0):
        self.accepted_count = accepted_count
        self.ids = tuple(ids)
        super().__init__('Technical output missing broker listings: ' + ', '.join(self.ids))


def technical_identity_instructions(prompt: str) -> str:
    outage = (' If dated chart evidence is unavailable, use Unavailable for Primary Setup, Confidence Score, '
              'Last 5 candles trend, Trigger Level and Invalidation Level, and Neutral for Bias.')
    if not ANCHORS.search(prompt):
        if prompt.lstrip().startswith('## Technical Scan Input Bundle'):
            return ('\nResearch the latest available completed daily session for each listing. '
                    'An intraday live quote is not required for daily chart analysis.' + outage)
        return ''
    return ('\nThe instrument field is the stable listing ID (EXCHANGE:SYMBOL). '
            'Return each ID exactly once by copying its two components into '
            'Exchange Symbol and Stock Symbol, respectively. Preserve venue and punctuation. Put a single numeric price in each available Trigger Level and Invalidation Level cell. '
            'Keep confirmation conditions and support levels outside those cells.' + outage)


def missing_listing_prompt(prompt: str, ids: tuple[str, ...]) -> str:
    match = ANCHORS.search(prompt)
    anchors = [a for a in json.loads(match[1]) if a['instrument'] in ids]
    return (prompt[:match.start(1)] + json.dumps(anchors) + prompt[match.end(1):]
            + technical_identity_instructions(prompt)
            + '\nCoverage repair: the only requested rows for this call are '
            + ', '.join(ids) + '. Return only these rows using the original table columns.')


def merge_technical_rows(previous: str, supplement: str) -> str:
    def tables(content):
        blocks, _ = parse_markdown(content)
        return [block for block in blocks if block.kind == 'table'
                and 'trigger level' in [h.strip().lower() for h in block.headers]]

    fragments = tables(previous) + tables(supplement)
    if not fragments:
        return previous
    header = [h.strip().lower() for h in fragments[0].headers]
    lines = fragments[0].text.splitlines()[:2]
    for block in fragments:
        if [h.strip().lower() for h in block.headers] != header:
            raise ValueError('Technical coverage repair changed the table columns')
        lines.extend(block.text.splitlines()[2:])
    return '\n'.join(lines)


class UnavailableTechnicalCoverage(ValueError):
    """A research scan returned listings but no usable chart setups."""


def unavailable_technical_setup(row):
    """Recognize a reported data outage without treating it as a directional signal."""
    if row.get('Bias', '').strip().casefold() not in {'neutral', 'unresolved', 'unavailable'}:
        return False
    if row.get('Confidence Score', '').strip().casefold() != 'unavailable':
        return False
    # Some providers explain the outage in prose. Explicitly absent chart
    # fields carry the same meaning regardless of the wording of that note.
    if all(row.get(field, '').strip().casefold() == 'unavailable'
           for field in ('Last 5 candles trend', 'Trigger Level', 'Invalidation Level')):
        return True
    return re.fullmatch(r'(?:(?:chart data|evidence)\s+)?unavailable(?:\s*[-–—:]\s*.+)?',
                        row.get('Primary Setup', '').strip(), re.I) is not None


def _unpriced_outage(headers, cells):
    row = dict(zip(headers, cells))
    return (all(row.get(field, '').strip().casefold() == 'unavailable'
                for field in ('Trigger Level', 'Invalidation Level'))
            and unavailable_technical_setup(row))


def validate_technical_prices(prompt: str, content: str) -> None:
    match = ANCHORS.search(prompt)
    if not match:
        if prompt.lstrip().startswith('## Technical Scan Input Bundle'):
            rows = [dict(zip(block.headers, row))
                    for block in parse_markdown(content)[0]
                    if block.kind == 'table' and 'Primary Setup' in block.headers
                    for row in block.rows]
            if rows and all(unavailable_technical_setup(row) for row in rows):
                raise UnavailableTechnicalCoverage(f'Technical Scan returned no usable chart data for any of {len(rows)} listings. '
                                 'Chart-dependent inputs are unavailable for the final calculation.')
        return
    anchors = json.loads(match[1])
    expected = {a['instrument']: float(a['price']) for a in anchors}
    if not expected or len(expected) != len(anchors) or any(not math.isfinite(p) or p <= 0 for p in expected.values()):
        raise ValueError('Technical broker price anchors are missing or invalid')
    blocks, _ = parse_markdown(content)
    seen = set()
    outages = set()
    for block in blocks:
        if block.kind != 'table':
            continue
        headers = [h.strip().lower() for h in block.headers]
        if 'stock symbol' not in headers or 'trigger level' not in headers:
            continue
        required = ['exchange symbol', 'stock symbol', 'trigger level', 'invalidation level']
        if any(h not in headers for h in required):
            raise ValueError('Technical price validation requires exchange, symbol, trigger and invalidation')
        for row in block.rows:
            if len(row) != len(headers):
                raise ValueError('Technical response has malformed price rows')
            values = dict(zip(headers, row))
            key = f"{values['exchange symbol'].strip().upper()}:{values['stock symbol'].strip().upper()}"
            if key not in expected or key in seen:
                raise ValueError(f'Technical output has unexpected or duplicate listing {key}')
            seen.add(key)
            if _unpriced_outage(block.headers, row):
                outages.add(key)
                continue
            for field in required[2:]:
                raw = values[field].strip().replace(',', '')
                if not re.fullmatch(r'\d+(?:\.\d+)?', raw):
                    raise ValueError(f'Technical {field} is not a reconciled numeric price for {key}')
                price = float(raw)
                if not math.isfinite(price) or abs(price / expected[key] - 1) > .25:
                    raise ValueError(f'Technical {field} differs by over 25% from broker anchor for {key}; reconcile price basis/corporate actions')
    if seen != set(expected):
        raise MissingTechnicalListings((key for key in expected if key not in seen), len(seen - outages))
    if outages == seen:
        raise UnavailableTechnicalCoverage(f'Technical Scan returned no usable chart data for any of {len(seen)} listings.')


# A leading directional clause names the actionable level. A trailing support
# condition may contain another price, so keep the original clause for audit.
_PRICE = r'(?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})+,\d{3}|\d+)(?:\.\d+)?'
_LEVEL = rf'(?:(?P<currency>₹|\$|INR|USD|Rs\.?)\s*)?(?P<price>{_PRICE})'
_DIRECTIONAL_LEVEL = re.compile(
    rf'(?:(?:reclaim|break(?:out|down)?|close|hold|sustain|cross)(?:s|es)?\s+)?'
    rf'(?:above|below)\s+{_LEVEL}'
    rf'(?:\s+(?:after|if|provided)\s+(?:a\s+)?(?:higher low|lower high|support|resistance)'
    rf'\s+(?:holds?|forms?)\s+at\s+(?:₹|\$)?{_PRICE})?', re.I,
)


_PRICE_LIST_PREFIX = re.compile(
    r'^(?:(?:trigger|entry)(?: levels?| prices?| range| zone)?[ :]+)?'
    r'(?:(?:above|below|between|around|near|either|from)\s+)?', re.I,
)
_PRICE_SEPARATOR = re.compile(r'\s*(?:[-–—/]|,\s+|\b(?:to|or|and)\b)\s*', re.I)


def _currency_matches(currency, exchange):
    if not currency:
        return True
    return (exchange.upper() in {'NSE', 'BSE'}) == (currency.lower() in {'₹', 'inr', 'rs', 'rs.'})


def _average_trigger(raw, exchange, anchor):
    """Average only an entire list of price alternatives, including both ends of a range."""
    parts = _PRICE_SEPARATOR.split(_PRICE_LIST_PREFIX.sub('', raw, count=1))
    if len(parts) < 2 or not math.isfinite(anchor) or anchor <= 0:
        return None, []
    candidates = []
    for part in parts:
        level = re.fullmatch(_LEVEL, part, re.I)
        if not level or not _currency_matches(level['currency'], exchange):
            return None, []
        price = level['price'].replace(',', '')
        if abs(float(price) / anchor - 1) > .25:
            return None, []
        candidates.append(price)
    with localcontext() as ctx:
        ctx.prec = max(len(price) for price in candidates) + len(str(len(parts))) + 10
        mean = sum(map(Decimal, candidates)) / len(candidates)
        places = max(2, max(len(price.partition('.')[2]) for price in candidates))
        return format(round(mean, places), 'f'), candidates


def normalize_technical_rows(prompt, content, evidence):
    """Return canonical rows and the rejected listing IDs for this response."""
    match = ANCHORS.search(prompt)
    if not match:
        return content, set()
    anchors = json.loads(match[1])
    expected = {a['instrument']: float(a['price']) for a in anchors}
    seen, excluded = set(), set()
    lines = content.splitlines(keepends=True)
    for block in parse_markdown(content)[0]:
        headers = [h.strip().lower() for h in block.headers]
        if block.kind != 'table' or 'trigger level' not in headers or 'stock symbol' not in headers:
            continue
        fields = ('trigger level', 'invalidation level')
        required = ('exchange symbol', 'stock symbol', *fields)
        if any(headers.count(field) != 1 for field in required):
            raise ValueError('Missing or duplicate technical price columns')
        for offset, row in enumerate(block.rows):
            if len(row) != len(headers):
                raise ValueError('Technical response has malformed price rows')
            values = dict(zip(headers, row))
            key = ':'.join(values[h].strip().upper() for h in required[:2])
            if key not in expected or key in seen:
                raise ValueError(f'Technical output has unexpected or duplicate listing {key}')
            seen.add(key)
            if _unpriced_outage(block.headers, row):
                continue
            cells = list(row)
            changed = False
            for field in fields:
                raw = values[field].strip()
                level = re.fullmatch(_LEVEL, raw, re.I) or _DIRECTIONAL_LEVEL.fullmatch(raw)
                value = level['price'].replace(',', '') if level else None
                candidates = []
                if level and not _currency_matches(level['currency'], values['exchange symbol']):
                    value = None
                if not level and field == 'trigger level':
                    value, candidates = _average_trigger(raw, values['exchange symbol'], expected[key])
                if value is None or not expected[key] > 0 or abs(float(value) / expected[key] - 1) > .25:
                    excluded.add(key)
                    evidence.append(dict(instrument=key, field=field, original=raw, status='excluded'))
                elif raw != value:
                    changed = True
                    cells[headers.index(field)] = value
                    record = dict(instrument=key, field=field, original=raw, price=value, status='extracted')
                    if candidates:
                        record.update(status='estimated_mean', candidates=candidates, anchor=expected[key])
                    evidence.append(record)
            index = block.line + 1 + offset
            if key in excluded:
                lines[index] = ''
            elif changed:
                ending = '\n' if lines[index].endswith('\n') else ''
                lines[index] = '| ' + ' | '.join(encode_cell(cell) for cell in cells) + ' |' + ending
    return ''.join(lines), excluded
