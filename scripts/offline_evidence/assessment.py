"""Offline, payload-free audit helpers. No service, database or provider access."""
import math
import statistics

CONDITIONS = ('source_sha', 'route', 'owner_scope', 'input_size', 'data_window',
              'cache_state', 'cpu', 'network', 'viewport', 'build', 'environment')


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def distribution(values):
    valid = [v for v in values if finite(v) and v >= 0]
    ordered = sorted(valid)
    return {'count': len(valid), 'excluded': len(values) - len(valid),
            'min': min(valid) if valid else None, 'max': max(valid) if valid else None,
            'median': statistics.median(valid) if valid else None,
            # Minimum count is a reporting guard, not proof of independence or an SLA.
            'p95': ordered[math.ceil(.95 * len(valid)) - 1] if len(valid) >= 20 else None,
            'status': 'measured' if valid else 'Not measured'}


def comparable(before, after):
    """SHA identifies each candidate; all other controlled dimensions must match."""
    missing = [key for key in CONDITIONS if before.get(key) is None or after.get(key) is None]
    changed = [key for key in CONDITIONS if key != 'source_sha' and before.get(key) != after.get(key)]
    return {'comparable': not missing and not changed, 'missing': missing, 'changed': changed}


def timeline(run):
    """Explicit numeric millisecond boundaries only; never infer a residual cause."""
    stages = {'queue': ('queued', 'started'), 'provider': ('attempt_started', 'attempt_finished'),
              'polling': ('finished', 'observed'), 'render': ('observed', 'rendered')}
    intervals, exclusions = {}, {}
    for stage, (start, end) in stages.items():
        a, b = run.get(start), run.get(end)
        if not run.get('run_id') or (stage == 'provider' and not run.get('attempt_id')):
            exclusions[stage] = 'missing explicit identity'
        elif not finite(a) or not finite(b) or b < a:
            exclusions[stage] = 'missing or invalid boundary'
        elif stage in run.get('reused_or_skipped', []):
            exclusions[stage] = 'reused or skipped'
        else:
            intervals[stage] = {'start_ms': a, 'end_ms': b, 'duration_ms': b - a}
    # Union prevents overlapping intervals from being double counted.
    merged = []
    for span in sorted(intervals.values(), key=lambda v: v['start_ms']):
        a, b = span['start_ms'], span['end_ms']
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(b, merged[-1][1])
        else:
            merged.append([a, b])
    total = None
    if finite(run.get('queued')) and finite(run.get('rendered')) and run['rendered'] >= run['queued']:
        total = run['rendered'] - run['queued']
    known = sum(b - a for a, b in merged)
    return {'intervals': intervals, 'exclusions': exclusions, 'known_union_ms': known,
            'unattributed_ms': total - known if total is not None and known <= total else None,
            'hidden_sdk_retries': 'unknown', 'whole_run_sla': 'Not established',
            'run_kind': run.get('run_kind', 'unknown')}


def reuse_eligibility(saved, requested, now_ms):
    """Assessment only. Does not implement a cache or suppress an evaluation."""
    keys = ('owner', 'evidence_digest', 'data_cutoff', 'schema', 'model')
    reasons = [f'{key} missing or changed' for key in keys
               if saved.get(key) is None or requested.get(key) is None or saved[key] != requested[key]]
    if requested.get('independent_sample') is not False:
        reasons.append('independent sample requested or unspecified')
    expiry = saved.get('expires_ms')
    if not finite(now_ms) or not finite(expiry) or now_ms >= expiry:
        reasons.append('expired or unknown expiry')
    return {'eligible_for_review': not reasons, 'reasons': reasons, 'live_reuse_authorized': False}
