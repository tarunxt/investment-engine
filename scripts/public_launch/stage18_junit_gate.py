"""Strict JUnit consistency gate, not an independent execution attestation."""
from collections import Counter
from pathlib import Path
import hashlib
import json
import re
import xml.etree.ElementTree as ET

REQUIRED_MODULES = {
    'test_stage18_migrations_postgres': 4,
    'test_stage18_queue_redis': 1,
    'test_stage18_migration_invariants': 10,
    'test_stage18_signup_clock': 2,
    'test_stage18_asgi_load': 1,
}


def verify(path, *, source_sha):
    if not isinstance(source_sha, str) or not re.fullmatch('[0-9a-f]{40}', source_sha):
        raise ValueError('Exact source identity required')
    payload = Path(path).read_bytes()
    if len(payload) > 8_000_000:
        raise ValueError('Bounded JUnit evidence required')
    root = ET.fromstring(payload)
    if root.tag not in {'testsuite', 'testsuites'}:
        raise ValueError('JUnit suite required')
    cases = root.findall('.//testcase')
    if not cases or root.findall('.//skipped') or root.findall('.//failure') or root.findall('.//error'):
        raise ValueError('Every selected check must execute and pass')
    identities = [(c.get('classname'), c.get('name')) for c in cases]
    if any(not all(pair) for pair in identities) or len(set(identities)) != len(identities):
        raise ValueError('Unique named executed cases required')
    # Pytest appends unittest class names; retain the module component rather
    # than confusing MigrationInvariants/JunitGate with a missing test module.
    counts = Counter(next((part for part in c.get('classname').split('.')
                          if part.startswith('test_')), c.get('classname')) for c in cases)
    for module, expected in REQUIRED_MODULES.items():
        if counts[module] != expected:
            raise ValueError('Required module count mismatch: '+module)
    return {'source_sha': source_sha, 'junit_sha256': hashlib.sha256(payload).hexdigest(),
            'executed': len(cases), 'skipped': 0, 'module_counts': dict(counts),
            'kind': 'junit_consistency_only', 'full_release_verified': False,
            'browser_load_verified': False, 'real_provider_certification': False}


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('junit'); parser.add_argument('--source-sha', required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.junit, source_sha=args.source_sha), sort_keys=True))
