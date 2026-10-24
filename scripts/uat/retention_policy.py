"""Synthetic, in-memory retention registry and dry-run policy. No deletion API.

This module is not connected to production writers, databases, queues or paths.
An eligibility result is a review candidate, never deletion authorization.
"""
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum


class Priority(str, Enum):
    CRITICAL = 'Critical'
    HIGH = 'High'
    MEDIUM = 'Medium'
    LOW = 'Low'
    UNKNOWN = 'Unclassified'


# Durations start at finalization; last access can extend, never shorten them.
RULES = {
    'operational_state': (Priority.CRITICAL, None),
    'recovery_copy': (Priority.CRITICAL, None),
    'user_result': (Priority.HIGH, None),
    'canonical_audit': (Priority.HIGH, None),
    'immutable_capture': (Priority.HIGH, None),
    'source_pack': (Priority.HIGH, None),
    'derived_intermediate': (Priority.MEDIUM, 14 * 86400),
    'failure_diagnostic': (Priority.MEDIUM, 30 * 86400),
    'page_cache': (Priority.LOW, 72 * 3600),
    'build_cache': (Priority.LOW, 7 * 86400),
    'abandoned_temporary': (Priority.LOW, 86400),
}
RECOVERY = {'EXACT_COPY_VERIFIED', 'DETERMINISTIC_REBUILD',
            'APPROXIMATE_REFETCH', 'NONE', 'UNKNOWN'}
POLICY_VERSION = 'uat-retention-dry-run-v1'


def timestamp(value):
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError('timezone-aware timestamp required')
    return value.astimezone(timezone.utc)


@dataclass
class Artifact:
    artifact_id: str
    environment: str
    owner: str
    workflow: str
    run_id: str
    kind: str
    provenance: str
    producer_version: str
    created_at: datetime
    logical_bytes: int = 0
    allocated_bytes: int = 0
    priority: Priority = field(init=False)
    policy_version: str = field(default=POLICY_VERSION, init=False)
    finalized_at: datetime | None = None
    last_access_at: datetime | None = None
    sha256: str | None = None
    recovery: str = 'UNKNOWN'
    exact_copy_digest: str | None = None
    recovery_verified_at: datetime | None = None
    rebuild_verified: bool = False
    disposal_allowed: bool = False
    terminal: bool = False
    writer_released: bool = False
    queue_checked_at: datetime | None = None
    references_checked_at: datetime | None = None
    external_references: int | None = None
    leases: set[str] = field(default_factory=set)
    holds: set[str] = field(default_factory=set)
    latest_success_pin: bool = False

    def __post_init__(self):
        for value in (self.artifact_id, self.owner, self.workflow, self.run_id,
                      self.kind, self.provenance, self.producer_version):
            if not isinstance(value, str) or not value.strip():
                raise ValueError('identity and provenance are required')
        if self.environment != 'uat-synthetic':
            raise ValueError('only synthetic UAT artifacts are accepted')
        for value in (self.logical_bytes, self.allocated_bytes):
            if type(value) is not int or value < 0:
                raise ValueError('invalid size')
        self.created_at = timestamp(self.created_at)
        self.priority = RULES.get(self.kind, (Priority.UNKNOWN, None))[0]
        if self.recovery not in RECOVERY:
            raise ValueError('unknown recoverability')


class Registry:
    """In-memory prototype. Register before writing; real transactional hooks are pending."""
    def __init__(self):
        self.artifacts = {}
        self.edges = set()  # consumer -> dependency; shared packs are first-class.
        self.generation = 0

    def register(self, artifact):
        if artifact.artifact_id in self.artifacts:
            raise ValueError('duplicate identity')
        self.artifacts[artifact.artifact_id] = artifact
        self.generation += 1

    def reference(self, consumer, dependency):
        if consumer not in self.artifacts or dependency not in self.artifacts:
            raise ValueError('unregistered dependency')
        self.edges.add((consumer, dependency))
        self.generation += 1

    def evaluate(self, artifact_id, now):
        now = timestamp(now)
        a = self.artifacts[artifact_id]
        reasons = []
        priority, ttl = RULES.get(a.kind, (Priority.UNKNOWN, None))
        if priority not in (Priority.LOW, Priority.MEDIUM) or a.priority != priority:
            reasons.append('protected classification')
        if a.holds or a.latest_success_pin:
            reasons.append('hold or latest-success pin')
        if not a.terminal or not a.writer_released or a.leases:
            reasons.append('active, resumable or unknown writer')
        refs = sum(dependency == artifact_id for _, dependency in self.edges)
        if refs or type(a.external_references) is not int or a.external_references != 0:
            reasons.append('references present or unknown')
        for label, checked in [('queue', a.queue_checked_at), ('references', a.references_checked_at)]:
            if checked is None or not timedelta(0) <= now - timestamp(checked) <= timedelta(minutes=5):
                reasons.append(label + ' evidence missing or stale')
        expires = None
        if a.finalized_at is None or ttl is None:
            reasons.append('no finite finalized retention')
        else:
            finalized = timestamp(a.finalized_at)
            accessed = timestamp(a.last_access_at or finalized)
            if finalized < a.created_at or accessed < a.created_at or max(finalized, accessed) > now:
                reasons.append('invalid chronology')
            expires = max(finalized, accessed) + timedelta(seconds=ttl)
            if now < expires:
                reasons.append('retention not elapsed')
        digest_valid = isinstance(a.sha256, str) and len(a.sha256) == 64 and all(c in '0123456789abcdef' for c in a.sha256)
        if not digest_valid:
            reasons.append('content digest unavailable')
        exact = (a.recovery == 'EXACT_COPY_VERIFIED' and digest_valid
                 and a.exact_copy_digest == a.sha256 and a.recovery_verified_at is not None
                 and timedelta(0) <= now - timestamp(a.recovery_verified_at) <= timedelta(minutes=5))
        deterministic = a.recovery == 'DETERMINISTIC_REBUILD' and a.rebuild_verified is True
        if not exact and not deterministic and not (a.disposal_allowed is True and a.recovery in {'NONE', 'APPROXIMATE_REFETCH'}):
            reasons.append('recovery or explicit loss policy unverified')
        return {'artifact_id': artifact_id, 'priority': priority.value,
                'policy_version': POLICY_VERSION, 'registry_generation': self.generation,
                'observed_at': now.isoformat(), 'expires_at': expires.isoformat() if expires else None,
                'allocated_bytes': a.allocated_bytes, 'reference_count': refs,
                'candidate': not reasons, 'logical_state': 'EXPIRED_CANDIDATE' if not reasons else 'PROTECTED',
                'physical_purge_authorized': False, 'recovery': a.recovery, 'reasons': reasons}


def admission(free_bytes, requested_peak_bytes, optional=True):
    """Provisional thresholds, pure decision only; no stop/start/schedule actions."""
    if any(type(v) is not int or v < 0 for v in (free_bytes, requested_peak_bytes)):
        return {'admit': False, 'reason': 'metrics unavailable'}
    gib = 1024 ** 3
    reserve = free_bytes - requested_peak_bytes
    if reserve < (10 if optional else 5) * gib:
        return {'admit': False, 'reason': 'reserve after peak reservation'}
    return {'admit': True, 'reason': 'warning' if reserve < 15 * gib else 'normal'}
