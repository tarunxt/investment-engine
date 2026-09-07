"""Recover missing source fields using Gamma's complete event keyset.

This applies to Trending and Full Universe exports without changing membership,
scan-time values, or frozen audit snapshots.
"""
from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Any

import httpx

from app.domains.polymarket_auto_live.stage_one_excel import encode_scan_export_data, decode_scan_export_data


def enrich_export_rows(rows: list[dict[str, Any]], *, budget_seconds: float = 420) -> None:
    by_id: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        saved = decode_scan_export_data(row)
        if saved['event'] and all(key in saved['market'] for key in ('id', 'outcomes', 'volume')):
            continue
        identity = str(row.get('market_id') or '')
        row['export_metadata'] = {'source': 'Historical scan', 'fetchedAt': 'N/A',
                                  'status': 'Source not yet recovered from Gamma event keyset.'}
        if identity:
            by_id.setdefault(identity, []).append(row)
    if not by_id:
        return
    deadline = time.monotonic() + budget_seconds
    timestamp = datetime.now(UTC).isoformat()
    cursor = None
    seen: set[str] = set()
    failure = 'Market absent from current open, unarchived Gamma events; historical source unavailable.'
    with httpx.Client(timeout=20, headers={'User-Agent': 'investment-engine-stage-one-export/1.0'}) as client:
        while by_id:
            if time.monotonic() >= deadline:
                failure = 'Gamma event keyset recovery time limit reached; source unavailable.'
                break
            params = {'archived': 'false', 'closed': 'false', 'limit': '500'}
            if cursor:
                params['after_cursor'] = cursor
            try:
                response = client.get('https://gamma-api.polymarket.com/events/keyset', params=params)
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, dict) or not isinstance(payload.get('events'), list):
                    raise ValueError('Gamma keyset response missing events')
            except (httpx.HTTPError, ValueError) as exc:
                status = getattr(getattr(exc, 'response', None), 'status_code', None)
                failure = f'Gamma event keyset lookup failed ({type(exc).__name__}, HTTP {status}); source unavailable.'
                break
            for event in payload['events']:
                if not isinstance(event, dict):
                    continue
                for market in event.get('markets') or []:
                    if not isinstance(market, dict):
                        continue
                    for row in by_id.pop(str(market.get('id')), []):
                        saved = decode_scan_export_data(row)
                        combined = {**market, **{k: v for k, v in saved['market'].items() if v is not None and v != ''}}
                        combined['_export_event'] = {**{k: v for k, v in event.items() if k != 'markets'},
                                                     **{k: v for k, v in saved['event'].items() if v is not None and v != ''}}
                        row['scan_export_data'] = encode_scan_export_data(
                            combined, candidate_text_fields_v1=saved.get('candidate_text_fields_v1'))
                        row['export_metadata'] = {
                            'source': 'Gamma events/keyset at export time (not historical scan time)',
                            'fetchedAt': timestamp,
                            'status': 'Full event and market source recovered; frozen scan values preserved. N/A means not provided or not applicable.',
                        }
            cursor = payload.get('next_cursor')
            if not cursor or cursor in ('LTE=', '-1'):
                break
            if cursor in seen:
                failure = 'Gamma repeated a cursor; source recovery incomplete.'
                break
            seen.add(cursor)
    for unmatched in by_id.values():
        for row in unmatched:
            row['export_metadata']['status'] = failure
