"""Fail closed on cross-scale technical levels for opt-in broker-anchored scans.

Historical/custom prompts are unchanged. No price, setup, or corporate-action
adjustment is synthesized to repair a rejected model response.
"""
import json
import math
import re
from .output_contracts.document import parse_markdown


def validate_technical_prices(prompt: str, content: str) -> None:
    match = re.search(r'\[TECHNICAL_PRICE_ANCHORS_V1\]\s*(.*?)\s*\[/TECHNICAL_PRICE_ANCHORS_V1\]', prompt, re.S)
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
        raise ValueError('Technical output does not cover every broker-anchored listing')
