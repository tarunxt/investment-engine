"""Validate sanitized Stage00 evidence. Operator receipts are attestations, not proof.
No infrastructure operations or implicit promotion. Missing evidence fails closed.
"""
import argparse
import json
import math
import re
import time
from pathlib import Path

REQUIRED = (
    'baseline_preserved', 'identity_and_filesystem_denial',
    'database_redis_isolation', 'session_key_separation',
    'owner_before_profile_write', 'alternate_auth_denied',
    'private_pages_assets_api_websockets', 'simulation_network_boundary',
    'schedulers_disabled', 'resource_and_disk_limits',
    'private_runtime_acceptance', 'five_actual_fault_tests',
    'stop_redeploy_namespace_cleanup', 'tls_chain_host_sni',
    'real_google_owner_acceptance', 'real_google_nonowner_denied',
    'production_health_before_after', 'cleanup_and_rollback',
)

def evaluate(receipt, *, expected_sha, now=None):
    now = time.time() if now is None else now
    if not re.fullmatch(r'[0-9a-f]{40}', expected_sha):
        raise ValueError('exact source SHA required')
    if type(now) not in (int, float) or not math.isfinite(now):
        raise ValueError('clock unavailable')
    if not isinstance(receipt, dict) or set(receipt) != {
        'source_sha', 'architecture', 'target_instance',
        'architecture_approval_reference', 'checks',
    }:
        raise ValueError('receipt schema')
    if receipt['source_sha'] != expected_sha:
        raise ValueError('source mismatch')
    architecture = receipt['architecture']
    if architecture == 'existing-server':
        if receipt['target_instance'] != 'i-0b8ad0aebce8510cb':
            raise ValueError('existing-server target mismatch')
        extra = ('representative_shared_host_headroom',)
    elif architecture == 'approved-dedicated-host':
        if receipt['target_instance'] != 'i-0dea5617814f8b351':
            raise ValueError('dedicated target mismatch')
        reference = receipt['architecture_approval_reference']
        if not isinstance(reference, str) or not reference.strip():
            raise ValueError('dedicated architecture approval reference required')
        extra = ('dedicated_host_capacity',)
    else:
        raise ValueError('architecture not approved')
    checks = receipt['checks']
    if not isinstance(checks, dict) or set(checks) != set(REQUIRED + extra):
        raise ValueError('missing or unknown acceptance checks')
    failures = []
    for name, check in checks.items():
        if not isinstance(check, dict) or set(check) != {'status', 'observed_epoch', 'evidence_reference'}:
            raise ValueError('check schema')
        observed = check['observed_epoch']
        if type(observed) not in (int, float) or not math.isfinite(observed):
            raise ValueError('check clock unavailable')
        reference = check['evidence_reference']
        if not isinstance(reference, str) or not reference.strip():
            raise ValueError('evidence reference required')
        if check['status'] != 'PASS' or not 0 <= now - observed <= 10800:
            failures.append(name)
    return {
        'status': 'BLOCKED' if failures else 'EVIDENCE_REVIEW_READY',
        'failed_or_stale': sorted(failures),
        'stage01_authorized': False,
        'existing_server_implemented': architecture == 'existing-server' and not failures,
        'qualification': 'Validate referenced evidence independently; this receipt cannot authorize deployment or Stage01.',
    }

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('receipt', type=Path)
    parser.add_argument('--expected-sha', required=True)
    args = parser.parse_args()
    try:
        if args.receipt.stat().st_size > 65536:
            raise ValueError('oversized receipt')
        result = evaluate(json.loads(args.receipt.read_text()), expected_sha=args.expected_sha)
    except (ValueError, OSError, TypeError) as exc:
        print(json.dumps({'status': 'BLOCKED', 'reason': str(exc), 'stage01_authorized': False}))
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0 if result['status'] == 'EVIDENCE_REVIEW_READY' else 2

if __name__ == '__main__':
    raise SystemExit(main())
