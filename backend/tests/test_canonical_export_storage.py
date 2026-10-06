import hashlib
import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest

from app.domains.trading_bots import export_payloads, storage_budget
from app.domains.trading_bots.storage_references import ReferenceInventory


def publish(root, archive, identity, data=b'{"row":"unchanged"}\n'):
    root.mkdir(exist_ok=True)
    archive.mkdir(exist_ok=True)
    path = root / f'{identity}.jsonl'
    path.write_bytes(data)
    result = export_payloads.publish_payload(path, archive, size=len(data), digest=hashlib.sha256(data).hexdigest())
    return path, result


def test_exact_captures_share_primary_and_archive_independently(tmp_path):
    root, archive = tmp_path / 'primary', tmp_path / 'archive'
    first, manifest = publish(root, archive, 'first')
    second, again = publish(root, archive, 'second')
    assert first.stat().st_ino == second.stat().st_ino
    assert (archive / first.name).stat().st_ino == (archive / second.name).stat().st_ino
    assert export_payloads.independent(first, archive / first.name)
    assert manifest['independentRecovery'] and again['sha256'] == manifest['sha256']
    second.write_bytes(b'corrupt')
    assert first.read_bytes() == b'corrupt'  # primary aliases intentionally share
    assert (archive / first.name).read_bytes() == b'{"row":"unchanged"}\n'


def test_corrupt_existing_content_is_pinned_never_overwritten(tmp_path):
    root, archive = tmp_path / 'primary', tmp_path / 'archive'
    first, manifest = publish(root, archive, 'first')
    canonical = root / 'immutable-payloads' / f'{manifest["sha256"]}.jsonl'
    canonical.write_bytes(b'corrupt')
    second = root / 'second.jsonl'
    second.write_bytes(b'{"row":"unchanged"}\n')
    with pytest.raises(ValueError, match='CORRUPT'):
        export_payloads.publish_payload(second, archive, size=second.stat().st_size, digest=manifest['sha256'])
    assert canonical.read_bytes() == b'corrupt' and second.read_bytes() != b'corrupt'


def test_hardlink_only_recovery_is_rejected(tmp_path):
    root, archive = tmp_path / 'primary', tmp_path / 'archive'
    root.mkdir(); archive.mkdir()
    data = b'rows\n'
    path = root / 'source.jsonl'; path.write_bytes(data)
    digest = hashlib.sha256(data).hexdigest()
    recovery = archive / 'immutable-payloads'; recovery.mkdir()
    import os
    os.link(path, recovery / f'{digest}.jsonl')
    with pytest.raises(ValueError, match='INDEPENDENT'):
        export_payloads.publish_payload(path, archive, size=len(data), digest=digest)
    assert path.read_bytes() == data


def test_failed_recovery_copy_never_adopts_or_publishes_logical_archive(tmp_path):
    root, archive = tmp_path / 'primary', tmp_path / 'archive'
    root.mkdir(); archive.mkdir()
    path = root / 'source.jsonl'; path.write_bytes(b'rows\n')
    def fail_copy(source, destination, **kwargs):
        destination.write_bytes(b'ro')
        raise OSError(28, 'disk full')
    with patch.object(export_payloads, 'copy_regular', side_effect=fail_copy):
        with pytest.raises(OSError):
            export_payloads.publish_payload(path, archive, size=5, digest=hashlib.sha256(b'rows\n').hexdigest())
    assert path.read_bytes() == b'rows\n'
    assert not (archive / path.name).exists()
    assert not list((archive / 'immutable-payloads').glob('*.jsonl'))


def test_concurrent_claims_include_future_recovery_and_fail_closed_metadata(tmp_path, monkeypatch):
    monkeypatch.setattr(storage_budget, '_available', lambda path: storage_budget.RESERVE_BYTES + 100)
    a = storage_budget.StorageBudget(tmp_path, identity='capture-a')
    b = storage_budget.StorageBudget(tmp_path, identity='capture-b')
    a.reserve_many([(tmp_path, 40), (tmp_path, 40)])
    with pytest.raises(OSError, match='Concurrent'):
        b.reserve(tmp_path, 30)
    a.consume(tmp_path, 40)
    b.reserve(tmp_path, 30)
    assert sum(c['pending'][str(tmp_path.stat().st_dev)] for c in a.snapshot()['claims'].values()) == 70
    a.release(); b.release()
    a.path.write_text('broken')
    with pytest.raises(OSError, match='Invalid reservation'):
        b.reserve(tmp_path, 1)
    assert a.path.read_text() == 'broken'


def test_restart_does_not_reap_unknown_reservations_or_steal_owner(tmp_path):
    original = storage_budget.StorageBudget(tmp_path, identity='first', token='stable')
    original.reserve(tmp_path, 8)
    restarted = storage_budget.StorageBudget(tmp_path, identity='other', token='stable')
    with pytest.raises(OSError, match='Invalid reservation'):
        restarted.release()
    assert original.snapshot()['claims']['stable']['pending']
    assert original.snapshot()['automaticReaping'] is False
    original.release()


def test_references_collect_shared_history_audit_and_pin_unknowns():
    report = ReferenceInventory()
    pack = 'a' * 32
    value = f'source-v1:{pack}:8:10:{"b" * 64}'
    export = '00000000-0000-0000-0000-000000000042'
    report.observe({'run': [value], 'export': export}, origin='frozen-run')
    report.observe(json.dumps({'scan_export_data': value}), origin='old-audit-text')
    report.observe('source-v1:unknown-format', origin='unknown-schema')
    result = report.report()
    assert result['sourcePacks'][pack] == ['frozen-run', 'old-audit-text']
    assert result['logicalExports'][export] == ['frozen-run']
    assert result['unknownPinned'] and result['missingAuthoritativeSources']
    assert not result['deletionEnabled'] and result['safeReclaimableBytes'] is None


def test_reference_limit_pins_omitted_dependencies():
    inventory = ReferenceInventory()
    inventory.observe({'a': ['b'] * 5}, origin='large', node_limit=2)
    assert inventory.report()['unknownPinned']


def test_explicit_rollback_materializes_only_selected_alias_and_preserves_bytes(tmp_path):
    root, archive = tmp_path / 'primary', tmp_path / 'archive'
    first, manifest = publish(root, archive, 'first')
    second, _ = publish(root, archive, 'second')
    metadata = {'exportId': 'second', 'immutableRowsStorage': manifest,
                'rowsBytes': manifest['bytes'], 'rowsSha256': manifest['sha256']}
    second.with_suffix('.json').write_text(json.dumps(metadata))
    before = second.stat().st_ino
    preview = export_payloads.materialize_legacy_alias(second, archive)
    assert preview['dryRun'] and second.stat().st_ino == before
    with pytest.raises(ValueError, match='quiescence'):
        export_payloads.materialize_legacy_alias(second, archive, apply=True)
    export_payloads.materialize_legacy_alias(second, archive, apply=True, writers_quiesced=True)
    restored = json.loads(second.with_suffix('.json').read_text())
    assert 'immutableRowsStorage' not in restored and 'rowsSha256' not in restored
    assert restored['storageRollback']['originalImmutableRowsStorage'] == manifest
    assert second.stat().st_ino != first.stat().st_ino
    assert second.read_bytes() == first.read_bytes()
    second.write_bytes(b'wallet augmentation')
    assert first.read_bytes() == b'{"row":"unchanged"}\n'
    assert (archive / first.name).read_bytes() == first.read_bytes()


def test_sqlalchemy_reference_collection_is_select_only_and_disables_autoflush():
    from contextlib import nullcontext
    class ReadOnlySession:
        no_autoflush = nullcontext()
        def execute(self, statement):
            assert statement.is_select
            columns = list(statement.selected_columns)
            count = sum(column.primary_key for column in columns)
            return [tuple(['record-id'] * count + [f'source-v1:{"a" * 32}:0:1:{"b" * 64}'] * (len(columns) - count))]
    inventory = ReferenceInventory()
    inventory.database(ReadOnlySession())
    assert inventory.report()['sourcePacks']['a' * 32]
    assert inventory.report()['missingAuthoritativeSources']


def test_snapshot_is_read_only_and_reserved_zip_rewrites_do_not_allocate_twice(tmp_path):
    budget = storage_budget.StorageBudget(tmp_path, identity='zip')
    assert not budget.path.exists()
    assert budget.snapshot()['claims'] == {}
    assert not budget.path.exists()
    file = tmp_path / 'temporary'
    with file.open('w+b', buffering=0) as raw:
        output = storage_budget.ReservedFile(raw, budget, tmp_path)
        output.write(b'header')
        output.seek(0)
        output.write(b'rewrite')
        stamp = budget.path.stat().st_mtime_ns
        budget.snapshot()
        assert budget.path.stat().st_mtime_ns == stamp
    budget.release()
    assert file.read_bytes() == b'rewrite'


def test_rollback_does_not_clear_immutable_manifest_before_private_directory_sync(tmp_path, monkeypatch):
    root, archive = tmp_path / 'primary', tmp_path / 'archive'
    first, manifest = publish(root, archive, 'first')
    second, _ = publish(root, archive, 'second')
    metadata = {'exportId': 'second', 'immutableRowsStorage': manifest,
                'rowsBytes': manifest['bytes'], 'rowsSha256': manifest['sha256']}
    second.with_suffix('.json').write_text(json.dumps(metadata))
    def fail_sync(directory):
        raise OSError('injected directory fsync failure')
    monkeypatch.setattr(export_payloads, 'sync_directory', fail_sync)
    with pytest.raises(OSError, match='fsync failure'):
        export_payloads.materialize_legacy_alias(second, archive, apply=True, writers_quiesced=True)
    assert json.loads(second.with_suffix('.json').read_text()) == metadata
    assert second.stat().st_ino != first.stat().st_ino
    assert second.read_bytes() == first.read_bytes()


@pytest.mark.parametrize('kind', ['fifo', 'symlink'])
@pytest.mark.parametrize('artifact', ['payload', 'manifest', 'existing-canonical'])
def test_nonregular_canonical_and_rollback_artifacts_are_pinned(tmp_path, kind, artifact):
    root, archive = tmp_path / 'primary', tmp_path / 'archive'
    first, manifest = publish(root, archive, 'first')
    if artifact == 'existing-canonical':
        target = root / 'immutable-payloads' / f'{manifest["sha256"]}.jsonl'
    elif artifact == 'manifest':
        target = first.with_suffix('.json')
    else:
        target = first
    target.unlink(missing_ok=True)
    if kind == 'fifo': os.mkfifo(target)
    else: target.symlink_to('/dev/zero')
    with pytest.raises((ValueError, OSError)):
        if artifact == 'existing-canonical': publish(root, archive, 'second')
        elif artifact == 'manifest': export_payloads.materialize_legacy_alias(first, archive)
        else: export_payloads.integrity(first)
    assert target.is_symlink() if kind == 'symlink' else __import__('stat').S_ISFIFO(target.lstat().st_mode)


def test_canonical_read_rejects_replacement_race(tmp_path, monkeypatch):
    path = tmp_path / 'payload.jsonl'
    path.write_bytes(b'original')
    original_open = os.open
    def raced_open(target, flags, *args, **kwargs):
        path.unlink(); os.mkfifo(path)
        assert flags & os.O_NOFOLLOW and flags & os.O_NONBLOCK
        return original_open(target, flags, *args, **kwargs)
    monkeypatch.setattr(export_payloads.os, 'open', raced_open)
    with pytest.raises(ValueError, match='changed before read'):
        export_payloads.integrity(path)


def test_growing_copy_is_bounded_to_reserved_source_size(tmp_path, monkeypatch):
    from contextlib import contextmanager
    source, destination = tmp_path / 'source.jsonl', tmp_path / 'private.tmp'
    source.write_bytes(b'original')
    original_reader = export_payloads.regular_reader
    @contextmanager
    def growing_reader(path):
        with original_reader(path) as raw:
            class Proxy:
                def fileno(self): return raw.fileno()
                def read(self, size):
                    data = raw.read(size)
                    with source.open('ab') as writer: writer.write(b'extra' * 100)
                    return data
            yield Proxy()
    monkeypatch.setattr(export_payloads, 'regular_reader', growing_reader)
    with pytest.raises(ValueError, match='changed during read'):
        export_payloads.copy_regular(source, destination, expected_size=8)
    assert destination.read_bytes() == b'original'


def test_copy_rejects_growth_between_reservation_and_reopen(tmp_path):
    source, destination = tmp_path / 'source.jsonl', tmp_path / 'private.tmp'
    source.write_bytes(b'original-extra')
    with pytest.raises(ValueError, match='reserved copy size'):
        export_payloads.copy_regular(source, destination, expected_size=8)
    assert not destination.exists()
