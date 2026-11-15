"""Offline synthetic profile; no database, provider, network, or task execution.

Run from the repository root with PYTHONPATH=backend python
backend/tests/bench_sports_rankings_passive_reads.py.
"""
import hashlib
import json
from pathlib import Path
from statistics import median
from tempfile import TemporaryDirectory
from time import perf_counter
from unittest.mock import patch

from app.domains.sports_rankings import participant_read_cache
from app.domains.sports_rankings.polymarket_participants import (
    _load_participant_index,
    load_participant_index,
)
from app.domains.trading_bots import universal_scan


def profile(loader):
    original = json.loads
    samples = []
    for _ in range(5):
        parses = 0

        def decode(*args, **kwargs):
            nonlocal parses
            parses += 1
            return original(*args, **kwargs)

        with patch.object(json, "loads", decode):
            started = perf_counter()
            result = loader(17)
            elapsed = (perf_counter() - started) * 1000
        assert len(result["nfl"]["participants"]) == 2000
        samples.append({"ms": round(elapsed, 2), "json_parses": parses})
    return samples


def main():
    participant_read_cache._cache.clear()
    with TemporaryDirectory(prefix="sports-passive-profile-") as directory:
        root = Path(directory)
        owner = hashlib.sha256(b"17:universal").hexdigest()
        for index in range(128):
            stem = f"export-{index:03}"
            (root / f"{stem}.json").write_text(json.dumps({
                "ownerHash": owner, "universalSource": True, "completed": True,
                "exportId": stem,
                "updatedAt": f"2026-09-{index // 24 + 1:02}T{index % 24:02}:00:00+00:00",
                "padding": "x" * 65536,
            }), encoding="utf-8")
            (root / f"{stem}.jsonl").write_text("{}\n", encoding="utf-8")
            (root / f"{stem}.sports-participants.json").write_text(json.dumps({
                "schema_version": 2, "codes": {"nfl": {
                    "sport_id": "american-football",
                    "participants": [f"Team {i}" for i in range(2000)], "events": [],
                }},
            }), encoding="utf-8")
        with patch.object(universal_scan, "_readable_export_directories", return_value=(root,)):
            uncached = profile(_load_participant_index)
            reused = profile(load_participant_index)
        print(json.dumps({
            "synthetic_exports": 128,
            "synthetic_bytes": sum(path.stat().st_size for path in root.iterdir()),
            "uncached": uncached, "cold_then_reused": reused,
            "uncached_median_ms": median(sample["ms"] for sample in uncached),
            "warm_reuse_median_ms": median(sample["ms"] for sample in reused[1:]),
        }, indent=2))
    participant_read_cache._cache.clear()


if __name__ == "__main__":
    main()
