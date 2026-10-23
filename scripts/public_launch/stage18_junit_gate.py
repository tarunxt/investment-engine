"""Strict JUnit consistency gate, not an independent execution attestation."""
from collections import Counter
from pathlib import Path
import hashlib
import json
import re
import xml.etree.ElementTree as ET

# The complete selected rehearsal cohort at ae15428776d54e0abbc379c8fe63be4e17a5797d.
# Counts are named testcase nodes, not pytest's additional passed subtests.
# This is deliberately not the wider public-launch release matrix.
REQUIRED_MODULES = {
    'test_google_signin': 19,
    'test_stage06_modules': 38,
    'test_stage07_lifecycle': 21,
    'test_stage09_connections_postgres': 4,
    'test_stage17_application_composition_postgres': 3,
    'test_stage17_closure': 22,
    'test_stage17_disposable_consumer_services': 4,
    'test_stage18_asgi_load': 1,
    'test_stage18_junit_gate': 9,
    'test_stage18_migration_invariants': 13,
    'test_stage18_migrations_postgres': 6,
    'test_stage18_postgres_tools': 5,
    'test_stage18_queue_redis': 1,
    'test_stage18_signup_clock': 2,
}


# Independent test fixtures retain their own case list. This production list is
# deliberately fixed to the reviewed selected cohort, not learned from input XML.
_INVENTORY = json.loads(Path(__file__).with_name('stage18_junit_inventory.json').read_text())
REQUIRED_CASES = frozenset((case['classname'], case['name']) for case in _INVENTORY['cases'])


def _module(classname):
    return next((part for part in classname.split('.') if part.startswith('test_')), classname)


if (_INVENTORY.get('schema_version') != 1 or len(REQUIRED_CASES) != sum(REQUIRED_MODULES.values())
        or len(_INVENTORY['cases']) != len(REQUIRED_CASES)
        or Counter(_module(classname) for classname, _ in REQUIRED_CASES) != REQUIRED_MODULES):
    raise ValueError('Invalid selected-case inventory')

# Preserve the explicitly supported full pytest/unittest and bare module forms,
# but never allow an arbitrary replacement class under a known module.
_EXPECTED_NAMES = {(_module(classname), name): {classname, _module(classname)}
                   for classname, name in REQUIRED_CASES}
if len(_EXPECTED_NAMES) != len(REQUIRED_CASES):
    raise ValueError('Ambiguous selected-case inventory')


def verify(path, *, source_sha):
    if not isinstance(source_sha, str) or not re.fullmatch('[0-9a-f]{40}', source_sha):
        raise ValueError('Exact source identity required')
    payload = Path(path).read_bytes()
    if len(payload) > 8_000_000:
        raise ValueError('Bounded JUnit evidence required')
    root = ET.fromstring(payload)
    if root.tag not in {'testsuite', 'testsuites'}:
        raise ValueError('JUnit suite required')
    # Pytest's tests=205 may include 57 successful subtests beyond 148 named
    # testcase nodes. Do not equate that summary to the named-case inventory.
    # Failure/error/skip summaries, when present, must nevertheless be exact zero.
    for suite in root.iter():
        if suite.tag in {'testsuite', 'testsuites'}:
            for attribute in ('failures', 'errors', 'skipped', 'failure', 'error'):
                if attribute in suite.attrib and suite.get(attribute) != '0':
                    raise ValueError('Nonzero or malformed suite result summary')
    cases = root.findall('.//testcase')
    if not cases or root.findall('.//skipped') or root.findall('.//failure') or root.findall('.//error'):
        raise ValueError('Every selected check must execute and pass')
    identities = [(c.get('classname'), c.get('name')) for c in cases]
    if any(not all(pair) for pair in identities) or len(set(identities)) != len(identities):
        raise ValueError('Unique named executed cases required')
    # Pytest appends unittest class names; retain the module component rather
    # than confusing MigrationInvariants/JunitGate with a missing test module.
    counts = Counter(_module(c.get('classname')) for c in cases)
    if set(counts) - set(REQUIRED_MODULES):
        raise ValueError('Unexpected selected module')
    for module, expected in REQUIRED_MODULES.items():
        if counts[module] != expected:
            raise ValueError('Required module count mismatch: '+module)
    normalized = [(_module(classname), name) for classname, name in identities]
    if (len(set(normalized)) != len(normalized) or set(normalized) != set(_EXPECTED_NAMES)
            or any(classname not in _EXPECTED_NAMES.get((_module(classname), name), set())
                   for classname, name in identities)):
        raise ValueError('Exact selected case identity mismatch')
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
