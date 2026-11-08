"""Offline bounded reconciliation of an explicitly supplied retained projection.

No app imports or collection. Outputs aggregates only; never emits run IDs,
source references or raw rows. Saved workflow summaries are not Beat receipts.
"""
import argparse
from collections import Counter
from datetime import datetime
import gzip
import hashlib
import io
import os
import json
from pathlib import Path


def reconcile(document):
    primary = document['validation_input']['records']
    older = document.get('older_workflow_observations', [])
    if len(primary) > 1000 or len(older) > 1000:
        raise ValueError('Bounded input supports at most 1000 rows per collection')
    keys = [(row.get('market'), row.get('run_id')) for row in primary]
    if any(market is None or run is None for market, run in keys):
        raise ValueError('Missing primary market/run key')
    unique = set(keys)
    statuses = Counter(str(row.get('workflow_status_displayed', 'unknown')) for row in primary)
    timestamps = Counter()
    for row in primary:
        parsed = []
        for field in ('workflow_started_at_utc_derived', 'workflow_finished_at_utc_derived'):
            value = row.get(field)
            try:
                instant = datetime.fromisoformat(value.replace('Z', '+00:00')) if isinstance(value, str) else None
                if instant is not None and instant.utcoffset() is None:
                    instant = None
            except ValueError:
                instant = None
            timestamps[field + ('_usable' if instant else '_unknown')] += 1
            parsed.append(instant)
        if all(parsed):
            timestamps['both_instants_present'] += 1
            if parsed[1] < parsed[0]:
                timestamps['finish_before_start'] += 1
    overlapping = sum((r.get('market'), r.get('run_id')) in unique for r in older)
    return {
        'finding': 'A11-006',
        'scope': 'supplied historical workflow summaries only; no live collection',
        'primary_rows': len(primary), 'primary_unique_market_run_keys': len(unique),
        'primary_duplicate_rows': len(keys) - len(unique),
        'market_counts': dict(Counter(str(r.get('market')) for r in primary)),
        'historical_display_status_counts': dict(sorted(statuses.items())),
        'older_observation_rows': len(older), 'older_rows_overlapping_primary': overlapping,
        'observation_rows_total': len(primary) + len(older),
        'timestamp_field_coverage': dict(sorted(timestamps.items())),
        'schedule_obligation_linkage': {
            'linked_rows': 0, 'unknown_rows': len(primary),
            'reason': 'Projection supplies no authenticated Beat task/dispatch or approved expected obligation mapping. Market/run identity alone cannot join to a periodic schedule.',
            'expected_start': None, 'start_lag_seconds': None,
            'missed_obligation_count': None, 'execution_duration': None, 'cost': None,
        },
        'execution_terminal_verification': 'unknown; displayed statuses retained separately',
        'population_complete': False, 'pagination_verified': False,
        'coverage_declarations': document.get('coverage', {}),
        'limitations': [
            'Primary and older observations are separate; overlapping rows do not enlarge workflow denominator.',
            'Display-derived timestamps are not authenticated task receipt or investment-decision times.',
            'No elapsed time, missing duration or cost inferred.',
            'Historical QUEUED or COMPLETED does not establish current workers, scheduler health or investment success.',
            'No missed-run, uptime, RPO/RTO or owner objective approval inferred.',
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path, help='Private output path outside repository')
    parser.add_argument('--gzip-input', action='store_true')
    parser.add_argument('--expected-input-sha256', required=True)
    parser.add_argument('--expected-json-sha256', required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    if args.output.resolve().is_relative_to(root):
        parser.error('Actual evidence output must remain outside repository')
    if args.input.stat().st_size > 2_000_000:
        parser.error('Input exceeds bounded 2 MB projection limit')
    data = args.input.read_bytes()
    input_hash = hashlib.sha256(data).hexdigest()
    if input_hash != args.expected_input_sha256:
        parser.error('Input hash mismatch')
    raw = gzip.GzipFile(fileobj=io.BytesIO(data)).read(2_000_001) if args.gzip_input else data
    if len(raw) > 2_000_000:
        parser.error('Decoded projection exceeds 2 MB limit')
    raw_hash = hashlib.sha256(raw).hexdigest()
    if raw_hash != args.expected_json_sha256:
        parser.error('JSON hash mismatch')
    report = reconcile(json.loads(raw))
    report['verified_input'] = {'bytes': len(data), 'sha256': input_hash,
                                'json_bytes': len(raw), 'json_sha256': raw_hash}
    # Exclusive creation avoids silently overwriting retained evidence.
    with open(args.output, 'x', opener=lambda path, flags: os.open(path, flags, 0o600)) as stream:
        json.dump(report, stream, indent=2)
        stream.write('\n')
    print('Verified bounded reconciliation written privately; no raw records emitted.')


if __name__ == '__main__':
    main()
