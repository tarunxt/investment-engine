"""Validate append-only offline protocol events without choosing investment policy."""
from .deterministic import digest
from .validation import timestamp
import re


def ledger_gaps(entries):
    if not entries:
        return ["ledger.empty"]
    previous = None
    previous_time = None
    frozen = {}
    inspected = set()
    consumed = set()
    gaps = []
    for index, entry in enumerate(entries):
        prefix = f"ledger.{index}"
        when = timestamp(entry.get("at"))
        if when is None or previous_time and when <= previous_time:
            gaps.append(f"{prefix}.time_unknown_or_not_increasing")
        if entry.get("previous_entry_hash") != previous:
            gaps.append(f"{prefix}.chain_mismatch")
        for key in ("contract_hash", "corpus_hash", "code_hash", "reason", "split_version", "original_output_ids"):
            if not entry.get(key):
                gaps.append(f"{prefix}.{key}.missing")
        for key in ("contract_hash", "corpus_hash", "code_hash"):
            if not isinstance(entry.get(key), str) or not re.fullmatch(r"[0-9a-f]{64}", entry[key]):
                gaps.append(f"{prefix}.{key}.invalid")
        split = entry.get("split_version")
        event = entry.get("event")
        if event == "freeze":
            start, end = timestamp(entry.get("test_start_at")), timestamp(entry.get("test_end_at"))
            if split in frozen or start is None or end is None or start >= end:
                gaps.append(f"{prefix}.test_boundaries_missing_or_reused")
            # New test periods must not reuse any already inspected period.
            if start and any(start <= frozen[s][1] for s in inspected if frozen[s][1]):
                gaps.append(f"{prefix}.new_test_period_not_independent")
            frozen[split] = (start, end, tuple(entry.get(k) for k in ("contract_hash", "corpus_hash", "code_hash")))
        elif event == "inspect":
            if split not in frozen or split in consumed:
                gaps.append(f"{prefix}.test_not_frozen_or_consumed")
            elif when is None or frozen[split][1] is None or when < frozen[split][1]:
                gaps.append(f"{prefix}.outcome_window_not_mature")
            if split in frozen:
                if frozen[split][2] != tuple(entry.get(k) for k in ("contract_hash", "corpus_hash", "code_hash")):
                    gaps.append(f"{prefix}.frozen_inputs_changed")
                inspected.add(split)
        elif event in {"tune", "select", "retry"}:
            if "selected_parameters" not in entry:
                gaps.append(f"{prefix}.selection_not_recorded")
            consumed.update(inspected)
        else:
            gaps.append(f"{prefix}.event_unknown")
        previous = digest(entry)
        previous_time = when
    return gaps
