#!/usr/bin/env python3
"""Offline source inventory. Never import app settings or inspect installed packages."""
import argparse
import hashlib
import json
import re
import subprocess
from urllib.parse import quote


def source(ref, path):
    return subprocess.check_output(['git', 'show', f'{ref}:{path}'])


def inventory(ref):
    commit = subprocess.check_output(['git', 'rev-parse', '--verify', f'{ref}^{{commit}}'], text=True).strip()
    paths = ('backend/requirements.txt', 'frontend/package-lock.json')
    inputs = {path: source(commit, path) for path in paths}
    components = []
    for line in inputs[paths[0]].decode().splitlines():
        if not line.strip() or line.startswith('#'):
            continue
        match = re.fullmatch(r'([A-Za-z0-9_.-]+)==([^\s;]+)', line)
        if not match:
            raise ValueError('Unrecognized requirement; inventory would be incomplete')
        name, version = match.groups()
        normalized = re.sub(r'[-_.]+', '-', name).lower()
        components.append({'type': 'library', 'name': name, 'version': version,
                           'bom-ref': f'backend:{normalized}', 'purl': f'pkg:pypi/{normalized}@{quote(version, safe="")}'})
    lock = json.loads(inputs[paths[1]])
    for path, data in sorted(lock['packages'].items()):
        if not path:
            continue
        if not data.get('version') or data.get('link'):
            raise ValueError('Unresolved lock entry; inventory would be incomplete')
        name = data.get('name') or path.rsplit('node_modules/', 1)[-1]
        components.append({'type': 'library', 'name': name, 'version': data['version'],
                           'bom-ref': f'frontend:{path}',
                           'purl': f'pkg:npm/{quote(name, safe="/")}@{quote(data["version"], safe="")}',
                           'properties': [{'name': 'lockPath', 'value': path},
                                          {'name': 'development', 'value': str(bool(data.get('dev'))).lower()}]})
    return {'bomFormat': 'CycloneDX', 'specVersion': '1.5', 'version': 1,
            'metadata': {'component': {'type': 'application', 'name': 'investment-engine-source', 'version': commit},
                         'properties': [{'name': 'scope', 'value': 'Source pins only; deployed build completeness NOT established'},
                                        *[{'name': f'sha256:{path}', 'value': hashlib.sha256(data).hexdigest()} for path, data in inputs.items()]]},
            'components': components}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ref', required=True)
    args = parser.parse_args()
    print(json.dumps(inventory(args.ref), indent=2, sort_keys=True))
