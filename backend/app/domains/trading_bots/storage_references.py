"""Read-only reference observations; absence is never proof of safe deletion.

A caller supplies a read-only SQLAlchemy session/snapshot. This module creates no
connections, commits, credentials, retention schedule or destructive sweep.
"""
from __future__ import annotations

import re
from collections import defaultdict
from sqlalchemy import JSON, Text, select

SOURCE_REFERENCE = re.compile(r'source-v1:([a-f0-9]{32}):(\d+):(\d+):([a-f0-9]{64})')
EXPORT_ID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}')


class ReferenceInventory:
    def __init__(self):
        self.sources = defaultdict(set)
        self.exports = defaultdict(set)
        self.unknown = []
        self.observed_records = 0

    def observe(self, payload, *, origin: str, node_limit=1_000_000):
        self.observed_records += 1
        stack = [payload]
        seen = set()
        nodes = 0
        while stack:
            nodes += 1
            if nodes > node_limit:
                self.unknown.append({'source': origin, 'reason': 'payload traversal limit reached; omitted dependencies pinned'})
                return
            value = stack.pop()
            if isinstance(value, (dict, list)):
                if id(value) in seen:
                    continue
                seen.add(id(value))
                stack.extend(value.values() if isinstance(value, dict) else value)
            elif isinstance(value, str):
                # Scan text as well as structured fields: audit text and nested
                # snapshots may embed JSON without exposing its original schema.
                for match in SOURCE_REFERENCE.finditer(value):
                    self.sources[match.group(1)].add(origin)
                if any(not SOURCE_REFERENCE.fullmatch(match.group()) for match in re.finditer(r'source-v[0-9]+:[^\s\"\}\]]*', value)):
                    self.unknown.append({'source': origin, 'reason': 'malformed or unknown source reference'})
                for match in EXPORT_ID.finditer(value):
                    # Conservatively count every UUID string as a potential
                    # export identity, even when its field name is unfamiliar.
                    self.exports[match.group()].add(origin)

    def database(self, session):
        from app.domains.polymarket_auto_live import models as auto_models
        from app.domains.bullpen_run_audit import models as audit_models
        from app.domains.trading_bots import models as universal_models
        from app.infrastructure.database.base import Base
        del auto_models, audit_models, universal_models
        tables = sorted((table for table in Base.metadata.tables.values()
                         if table.name.startswith(('polymarket_auto_live_', 'bullpen_run_audit_', 'universal_scan_'))),
                        key=lambda table: table.name)
        with session.no_autoflush:
            for table in tables:
                payloads = [column for column in table.columns if isinstance(column.type, (JSON, Text))]
                if not payloads:
                    continue
                keys = list(table.primary_key.columns)
                try:
                    rows = session.execute(select(*keys, *payloads).execution_options(yield_per=100))
                    for row in rows:
                        identity = ':'.join(str(item) for item in row[:len(keys)])
                        for column, value in zip(payloads, row[len(keys):]):
                            self.observe(value, origin=f'{table.name}:{identity}:{column.name}')
                except Exception as exc:
                    self.unknown.append({'source': table.name, 'reason': f'database read unavailable ({type(exc).__name__}); remaining database dependencies pinned'})
                    break  # do not rollback/commit the caller's transaction

    def report(self):
        missing = ['redis queued/inflight/delayed tasks', 'Celery schedules and retries',
                   'frontend snapshots and external downloads', 'run-scoped page caches',
                   'consistent filesystem/database snapshot and external references']
        return {'dryRun': True, 'deletionEnabled': False, 'referenceClosureComplete': False,
                'safeReclaimableBytes': None, 'observedRecords': self.observed_records,
                'sourcePacks': {key: sorted(value) for key, value in sorted(self.sources.items())},
                'logicalExports': {key: sorted(value) for key, value in sorted(self.exports.items())},
                'unknownPinned': self.unknown, 'missingAuthoritativeSources': missing,
                'policy': 'Every object remains pinned, including objects with zero observed references.'}
