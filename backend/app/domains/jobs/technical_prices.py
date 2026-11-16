"""Fail closed on cross-scale technical levels for opt-in broker-anchored scans.

Historical/custom prompts are unchanged. No price, setup, or corporate-action
adjustment is synthesized to repair a rejected model response.
"""
import json
import math
import re
from .output_contracts.document import parse_markdown


ANCHORS = re.compile(r'\[TECHNICAL_PRICE_ANCHORS_V1\]\s*(.*?)\s*\[/TECHNICAL_PRICE_ANCHORS_V1\]', re.S)


class MissingTechnicalListings(ValueError):
    def __init__(self, ids):
        self.ids = tuple(ids)
        super().__init__('Technical output missing broker listings: ' + ', '.join(self.ids))


def technical_identity_instructions(prompt: str) -> str:
    if not ANCHORS.search(prompt):
        return ''
    return ('\nThe instrument field is the stable listing ID (EXCHANGE:SYMBOL). '
            'Return each ID exactly once by copying its two components into '
            'Exchange Symbol and Stock Symbol, respectively. Preserve venue and punctuation.')


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


def validate_technical_prices(prompt: str, content: str) -> None:
    match = ANCHORS.search(prompt)
    if not match:
        return
    anchors = json.loads(match[1])
    expected = {a['instrument']: float(a['price']) for a in anchors}
    if not expected or len(expected) != len(anchors) or any(not math.isfinite(p) or p <= 0 for p in expected.values()):
        raise ValueError('Technical broker price anchors are missing or invalid')
    blocks, _ = parse_markdown(content)
    seen = set()
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
            for field in required[2:]:
                raw = values[field].strip().replace(',', '')
                if not re.fullmatch(r'\d+(?:\.\d+)?', raw):
                    raise ValueError(f'Technical {field} is not a reconciled numeric price for {key}')
                price = float(raw)
                if not math.isfinite(price) or abs(price / expected[key] - 1) > .25:
                    raise ValueError(f'Technical {field} differs by over 25% from broker anchor for {key}; reconcile price basis/corporate actions')
    if seen != set(expected):
        raise MissingTechnicalListings(key for key in expected if key not in seen)
