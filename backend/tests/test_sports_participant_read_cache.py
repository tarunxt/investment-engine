import hashlib
import json
import os
from pathlib import Path

import pytest

from app.domains.sports_rankings import participant_read_cache as cache
from app.domains.sports_rankings.polymarket_participants import load_participant_index
from app.domains.trading_bots import universal_scan


@pytest.fixture
def exports(tmp_path, monkeypatch):
    cache._cache.clear()
    monkeypatch.setattr(universal_scan, "_readable_export_directories", lambda: (tmp_path, tmp_path))
    yield tmp_path
    cache._cache.clear()


def write_export(directory, export_id, *, user_id=17, minute=0, completed=True,
                 names=None, padding=0):
    metadata = {
        "ownerHash": hashlib.sha256(f"{user_id}:universal".encode()).hexdigest(),
        "universalSource": True, "completed": completed, "exportId": export_id,
        "updatedAt": f"2026-10-03T08:{minute:02}:00+00:00", "rowsBytes": 3,
        "padding": "x" * padding,
    }
    (directory / f"{export_id}.json").write_text(json.dumps(metadata))
    (directory / f"{export_id}.jsonl").write_text("{}\n")
    payload = {"schema_version": 2, "export_id": export_id, "codes": {
        "NFL": {"sport_id": "american-football", "participants": names or [export_id],
                "events": [{"slug": f"nfl-{export_id}", "title": "A vs B"}]},
    }}
    (directory / f"{export_id}.sports-participants.json").write_text(json.dumps(payload))
    return payload["codes"]["NFL"]


def spy_reads(monkeypatch):
    reads = []
    original = Path.read_text

    def observed(path, *args, **kwargs):
        reads.append(path.name)
        assert path.suffix != ".jsonl", "Passive reads must not parse market rows"
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", observed)
    return reads


def test_repeated_reads_parse_one_compact_payload_without_reopening_history(exports, monkeypatch):
    for i in range(30):
        expected = write_export(exports, f"export-{i}", minute=i, names=[f"Team {n}" for n in range(2000)], padding=65536)
    reads = spy_reads(monkeypatch)
    assert load_participant_index(17) == {"nfl": expected}
    assert len(reads) == 61  # 30 metadata, 30 sibling indexes, then selected index.
    reads.clear()
    parses = []
    original = json.loads

    def decode(payload, *args, **kwargs):
        parses.append(len(payload))
        return original(payload, *args, **kwargs)

    monkeypatch.setattr(json, "loads", decode)
    result = load_participant_index(17)
    assert result == {"nfl": expected} and len(result["nfl"]["participants"]) == 2000
    assert reads == [] and len(parses) == 1
    result["nfl"]["participants"].append("Caller mutation")
    assert load_participant_index(17) == {"nfl": expected}


def test_new_export_and_existing_inflight_completion_invalidate_immediately(exports):
    first = write_export(exports, "first", minute=1)
    assert load_participant_index(17) == {"nfl": first}
    second = write_export(exports, "second", minute=2, completed=False)
    assert load_participant_index(17) == {"nfl": first}
    metadata_path = exports / "second.json"
    metadata = json.loads(metadata_path.read_text())
    metadata["completed"] = True
    metadata_path.write_text(json.dumps(metadata))
    assert load_participant_index(17) == {"nfl": second}
    third = write_export(exports, "third", minute=3)
    assert load_participant_index(17) == {"nfl": third}


def test_same_size_index_edit_with_preserved_mtime_and_atomic_replace_are_seen(exports):
    expected = write_export(exports, "first", names=["Alpha"])
    assert load_participant_index(17) == {"nfl": expected}
    path = exports / "first.sports-participants.json"
    old = path.stat()
    path.write_text(path.read_text().replace("Alpha", "Bravo"))
    os.utime(path, ns=(old.st_atime_ns, old.st_mtime_ns))
    assert load_participant_index(17)["nfl"]["participants"] == ["Bravo"]
    temporary = exports / "replacement.tmp"
    temporary.write_text(path.read_text().replace("Bravo", "Delta"))
    os.utime(temporary, ns=(old.st_atime_ns, old.st_mtime_ns))
    temporary.replace(path)
    assert load_participant_index(17)["nfl"]["participants"] == ["Delta"]


@pytest.mark.parametrize("change", ["remove_rows", "wrong_rows_size", "remove_index", "bad_index", "bad_schema"])
def test_unavailable_export_or_index_never_reuses_last_good_result(exports, change):
    write_export(exports, "first", minute=1)
    write_export(exports, "latest", minute=2)
    assert load_participant_index(17)["nfl"]["participants"] == ["latest"]
    rows = exports / "latest.jsonl"
    index = exports / "latest.sports-participants.json"
    if change == "remove_rows":
        rows.unlink()
    elif change == "wrong_rows_size":
        rows.write_text("{}\n{}\n")
    elif change == "remove_index":
        index.unlink()
    elif change == "bad_index":
        index.write_text("not-json")
    else:
        index.write_text('{"schema_version":999,"codes":{}}')
    assert load_participant_index(17) == {}
    expected = write_export(exports, "latest", minute=2, names=["Repaired"])
    assert load_participant_index(17) == {"nfl": expected}


def test_owner_scoping_and_lru_capacity(exports):
    for user_id in range(10):
        write_export(exports, str(user_id), user_id=user_id, minute=user_id)
    for user_id in range(10):
        assert load_participant_index(user_id)["nfl"]["participants"] == [str(user_id)]
    assert len(cache._cache) == cache.MAX_CACHED_USERS == 8
    assert list(cache._cache) == list(range(2, 10))
    assert load_participant_index(0)["nfl"]["participants"] == ["0"]
    assert load_participant_index(999) == {}


@pytest.mark.parametrize("bound", ["files", "bytes"])
def test_reuse_bounds_never_truncate_complete_results(exports, monkeypatch, bound):
    write_export(exports, "first", minute=1)
    expected = write_export(exports, "last", minute=2, names=[f"Team {i}" for i in range(3000)])
    if bound == "files":
        monkeypatch.setattr(cache, "MAX_FINGERPRINT_FILES", 2)
    else:
        monkeypatch.setattr(cache, "MAX_CACHED_BYTES", 10)
    reads = spy_reads(monkeypatch)
    assert load_participant_index(17) == {"nfl": expected}
    initial_reads = len(reads)
    assert load_participant_index(17) == {"nfl": expected}
    assert len(reads) == initial_reads * 2
    assert len(cache._cache) == 0


def test_export_changed_during_cold_load_is_not_cached(exports):
    write_export(exports, "first", minute=1)
    calls = []

    def loader(user_id):
        calls.append(user_id)
        write_export(exports, "second", minute=2)
        return {"nfl": {"participants": ["first"]}}

    cache.load_with_export_reuse(17, loader)
    assert calls == [17] and len(cache._cache) == 0
    assert load_participant_index(17)["nfl"]["participants"] == ["second"]


def test_new_directory_and_missing_fingerprint_fall_back_to_complete_read(exports, monkeypatch):
    nested = exports / "new-directory"
    monkeypatch.setattr(universal_scan, "_readable_export_directories", lambda: (nested,))
    assert load_participant_index(17) == {}
    nested.mkdir()
    expected = write_export(nested, "first")
    assert load_participant_index(17) == {"nfl": expected}
    reads = spy_reads(monkeypatch)
    monkeypatch.setattr(cache, "_export_fingerprint", lambda: None)
    assert load_participant_index(17) == {"nfl": expected}
    assert len(reads) == 3


@pytest.mark.parametrize("payload", [[], None, "invalid", 7, True, {"schema_version": 2, "codes": []}])
def test_real_resolver_returns_no_dynamic_participants_for_malformed_latest_index(exports, payload):
    write_export(exports, "first", minute=1)
    latest = write_export(exports, "latest", minute=2)
    other_user = write_export(exports, "other-user", user_id=23, minute=3)
    assert load_participant_index(17) == {"nfl": latest}
    (exports / "latest.sports-participants.json").write_text(json.dumps(payload))

    # Exercise real directory discovery, including the malformed sibling JSON.
    # Keep the owner's latest export selected; never substitute an older index
    # or another user's participants for an unavailable compact index.
    metadata, rows = universal_scan.latest_completed_universal_export(17)
    assert metadata["exportId"] == "latest" and rows == exports / "latest.jsonl"
    assert load_participant_index(17) == {}
    assert load_participant_index(17) == {}
    assert load_participant_index(23) == {"nfl": other_user}
    repaired = write_export(exports, "latest", minute=2, names=["Repaired"])
    assert load_participant_index(17) == {"nfl": repaired}
