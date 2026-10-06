import importlib.util
import os
from pathlib import Path

spec = importlib.util.spec_from_file_location('scan_inventory', Path(__file__).resolve().parents[2] / 'scripts/inventory-scan-storage.py')
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


def test_symlink_roots_directories_files_and_fifos_are_explicitly_pinned(tmp_path):
    root = tmp_path / 'root'
    root.mkdir()
    (root / 'data.pack').write_bytes(b'data')
    (root / 'dir').mkdir()
    (root / 'dir-link').symlink_to(root / 'dir', target_is_directory=True)
    (root / 'file-link').symlink_to(root / 'data.pack')
    os.mkfifo(root / 'pipe')
    (tmp_path / 'root-link').symlink_to(root, target_is_directory=True)
    result = inventory.inventory([root, tmp_path / 'root-link', tmp_path / 'root-link' / 'dir'])
    assert len(result['files']) == 1
    assert len(result['unknownPinned']) == 5
    assert all(item['pinned'] for item in result['unknownPinned'])
    assert result['errors'] and not result['referenceClosureComplete']
    assert result['safeReclaimableBytes'] is None


def test_unreadable_subtree_is_recorded_not_omitted(tmp_path, monkeypatch):
    forbidden = tmp_path / 'unreadable'
    forbidden.mkdir()
    original = os.scandir
    def inaccessible(path):
        if Path(path) == forbidden:
            raise PermissionError(13, 'denied', str(forbidden))
        return original(path)
    monkeypatch.setattr(inventory.os, 'scandir', inaccessible)
    result = inventory.inventory([tmp_path])
    assert any(item['path'] == str(forbidden) for item in result['unknownPinned'])
    assert any('unreadable directory' in item['error'] for item in result['errors'])


def test_duplicate_files_and_overlapping_roots_do_not_imply_reclaim(tmp_path):
    (tmp_path / 'first').write_bytes(b'same')
    (tmp_path / 'second').write_bytes(b'same')
    result = inventory.inventory([tmp_path, tmp_path])
    assert len(result['files']) == 2
    assert len(result['exactWholeFileDuplicateGroups']) == 1
    assert all(item['pinned'] for item in result['files'])
    assert not result['deletionEnabled'] and result['safeReclaimableBytes'] is None


def test_bounded_inventory_pins_remaining_traversal(tmp_path):
    (tmp_path / 'first').write_bytes(b'same')
    (tmp_path / 'second').write_bytes(b'same')
    result = inventory.inventory([tmp_path], max_total_bytes=4)
    assert len(result['files']) == 1
    assert result['resourceLimitReached']
    assert result['unknownPinned'] and not result['referenceClosureComplete']
