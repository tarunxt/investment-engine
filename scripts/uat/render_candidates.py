#!/usr/bin/env python3
"""Render non-installed UAT candidates from reviewed capacity measurements.

No defaults for resource budgets, no sudo, no service or network changes.
Candidate files alone NEVER authorize exposure/startup.
"""
import argparse
import json
from pathlib import Path
from string import Template

NUMERIC_FIELDS = {
    'cpu_quota_percent', 'memory_high_bytes', 'memory_max_bytes', 'tasks_max',
    'io_read_bytes_sec', 'io_write_bytes_sec', 'redis_maxmemory_bytes',
    'stop_mem_available_bytes', 'stop_disk_free_bytes', 'stop_inodes_free',
}


def validate(data):
    if data.get('representative_periods_reviewed') is not True:
        raise ValueError('Representative production evidence has not been reviewed')
    if not isinstance(data.get('evidence_reference'), str) or not data['evidence_reference'].strip():
        raise ValueError('Missing capacity evidence reference')
    for field in NUMERIC_FIELDS:
        if type(data.get(field)) is not int or data[field] <= 0:
            raise ValueError('Missing positive measured budget: ' + field)
    if data['memory_high_bytes'] >= data['memory_max_bytes']:
        raise ValueError('MemoryHigh must be below MemoryMax')
    if data['redis_maxmemory_bytes'] >= data['memory_high_bytes']:
        raise ValueError('Redis budget leaves no room for other UAT processes')
    device = data.get('io_device', '')
    # Major:minor avoids interpolating arbitrary paths or systemd directives.
    import re
    if not re.fullmatch(r'[0-9]+:[0-9]+', device):
        raise ValueError('io_device must be verified block device major:minor')
    return data


def render(manifest, destination):
    values = validate(manifest)
    templates = Path(__file__).resolve().parents[2] / 'deploy/uat/templates'
    destination.mkdir(parents=True, exist_ok=False)
    for source in sorted(templates.glob('*.in')):
        target = destination / (source.name[:-3] + '.candidate')
        target.write_text(Template(source.read_text()).substitute(values))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    render(json.loads(args.manifest.read_text()), args.destination)
