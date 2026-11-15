#!/usr/bin/env python3
"""Bounded, one-shot host reserve check. Only --enforce may stop UAT units.

Run repeatedly from a separately reviewed timer. Never starts/restarts anything.
No credentials, production service controls or network requests are used.
"""
import argparse
import json
import math
from pathlib import Path
import subprocess

from collect_headroom import sample
from render_candidates import validate

# Fixed names only: never accept a unit name from a file, environment or argument.
UAT_UNITS = (
    'credx-uat-frontend.service', 'credx-uat-backend.service',
    'credx-uat-redis.service', 'credx-uat-postgres.service',
    'credx-uat-barrier.service',
)


def pressure_avg10(value):
    line = next(line for line in value.splitlines() if line.startswith('some '))
    fields = dict(field.split('=', 1) for field in line.split()[1:])
    average = float(fields['avg10'])
    if not math.isfinite(average) or not 0 <= average <= 100:
        raise ValueError('invalid pressure sample')
    return average


def violations(metrics, limits):
    reasons = []
    for actual, threshold, name in (
        (metrics['memory']['MemAvailable_bytes'], limits['stop_mem_available_bytes'], 'memory reserve'),
        (metrics['disk_free_bytes'], limits['stop_disk_free_bytes'], 'disk reserve'),
        (metrics['inodes_free'], limits['stop_inodes_free'], 'inode reserve'),
    ):
        if type(actual) is not int or actual < 0:
            raise ValueError('invalid reserve sample')
        if actual <= threshold:
            reasons.append(name)
    for resource in ('cpu', 'memory', 'io'):
        if pressure_avg10(metrics['pressure'][resource]) >= limits[f'stop_{resource}_pressure_avg10']:
            reasons.append(resource + ' pressure')
    return reasons


def check(manifest, filesystem, *, enforce=False, sample_fn=sample, run=subprocess.run):
    try:
        limits = validate(json.loads(manifest.read_text()))
        reasons = violations(sample_fn(filesystem), limits)
    except Exception:
        # Do not print raw exceptions or configuration. Missing metrics fail safe.
        reasons = ['configuration or metrics unavailable']
    if not reasons:
        return {'status': 'healthy', 'stopped': False}
    if not enforce:
        return {'status': 'would_stop', 'reasons': reasons, 'stopped': False}
    try:
        result = run(['/usr/bin/systemctl', 'stop', *UAT_UNITS],
                     timeout=30, capture_output=True, check=False)
        stopped = result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        stopped = False
    return {'status': 'stopped' if stopped else 'stop_failed',
            'reasons': reasons, 'stopped': stopped}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--filesystem', required=True)
    parser.add_argument('--enforce', action='store_true')
    args = parser.parse_args()
    result = check(args.manifest, args.filesystem, enforce=args.enforce)
    print(json.dumps(result))
    raise SystemExit(0 if result['status'] == 'healthy' else 2)
