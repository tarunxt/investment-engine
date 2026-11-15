import pytest
from app.domains.polymarket_auto_live import scan_source_store as store
from app.domains.polymarket_auto_live.stage_one_excel import encode_scan_export_data, decode_scan_export_data


def test_pack_preserves_every_source_field_without_large_run_json(tmp_path, monkeypatch):
    monkeypatch.setattr(store, 'SOURCE_ROOT', tmp_path)
    raw = {'id': '42', 'volume': 0, 'active': False, 'description': 'Long rules ' * 1000,
           '_export_event': {'id': '7', 'tags': [{'label': 'Politics'}], 'extra': {'a': 1}}}
    row = {'scan_export_data': encode_scan_export_data(raw)}
    expected = decode_scan_export_data(row)
    with store.ScanSourceWriter() as writer:
        writer.store(row)
    assert len(row['scan_export_data']) < 160
    assert decode_scan_export_data(row) == expected
    assert decode_scan_export_data({'scan_export_data': encode_scan_export_data(raw)}) == expected


def test_pack_checks_integrity_and_rejects_path_traversal(tmp_path, monkeypatch):
    monkeypatch.setattr(store, 'SOURCE_ROOT', tmp_path)
    row = {'scan_export_data': encode_scan_export_data({'id': '42'})}
    with store.ScanSourceWriter() as writer:
        writer.store(row)
    next(tmp_path.glob('*.pack')).write_bytes(b'broken')
    with pytest.raises(ValueError, match='incomplete or corrupted'):
        decode_scan_export_data(row)
    with pytest.raises(ValueError, match='Invalid'):
        store.read_scan_source('source-v1:../../secret:0:10:bad')
