#!/usr/bin/env python3
"""Read-only Linux capacity sampler. Emits metrics, never process/env contents.

Run during representative market, worker, backup and quiet periods. This does
not decide that the host is safe, install software, or contact any database.
"""
import argparse
import datetime as dt
import json
from pathlib import Path
import shutil
import subprocess
import time
import os


def command(args):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return "UNAVAILABLE"
    return result.stdout.strip() if result.returncode == 0 else "UNAVAILABLE"


def sample(path):
    memory = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        key, value = line.split(':', 1)
        if key in {'MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree'}:
            memory[key + '_bytes'] = int(value.split()[0]) * 1024
    disk = shutil.disk_usage(path)
    fs = os.statvfs(path)
    cpu = list(map(int, Path('/proc/stat').read_text().splitlines()[0].split()[1:9]))
    pressure = {}
    for resource in ('cpu', 'memory', 'io'):
        source = Path('/proc/pressure') / resource
        pressure[resource] = source.read_text().strip() if source.exists() else 'UNAVAILABLE'
    return {
        'utc': dt.datetime.now(dt.timezone.utc).isoformat(),
        'memory': memory, 'cpu_ticks': cpu, 'load': os.getloadavg(),
        'pressure': pressure, 'disk_free_bytes': disk.free,
        'disk_total_bytes': disk.total, 'inodes_free': fs.f_favail,
        'inodes_total': fs.f_files,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--samples', type=int, default=12)
    parser.add_argument('--interval', type=float, default=5)
    parser.add_argument('--filesystem', default='/srv')
    parser.add_argument('--repo', default='/srv/investor')
    args = parser.parse_args()
    if args.samples < 2 or args.interval < 1:
        parser.error('at least two samples and interval >= 1 second required')
    print(json.dumps({'kind': 'inventory', 'utc': dt.datetime.now(dt.timezone.utc).isoformat(),
        'cpu_count': os.cpu_count(),
        'checkout_sha_NOT_running_sha': command(['git', '-C', args.repo, 'rev-parse', 'HEAD']),
        'listening_tcp': command(['ss', '-H', '-ltn']),
        'timers': command(['systemctl', 'list-timers', '--all', '--no-pager']),
        'units': command(['systemctl', 'list-units', '--all', '--no-pager',
                          'investor-*', 'investment-engine-*', 'postgresql*', 'redis*', 'nginx*']),
    }), flush=True)
    for index in range(args.samples):
        print(json.dumps({'kind': 'sample', **sample(args.filesystem)}), flush=True)
        if index + 1 < args.samples:
            time.sleep(args.interval)


if __name__ == '__main__':
    main()
