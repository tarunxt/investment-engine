"""Shared additive evidence contract for metering and cost consumers.

Schema version is independent of tariff identity. Repository rates are not
provider-verified current rates or settled charges. Legacy numeric fields stay
unchanged; consumers must not merge inferred cache values into reported usage.
"""
from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping

from app.domains.api_usage.usage_metadata import number

SCHEMA_VERSION = 1
RATE_KEYS = ("input", "output", "cache_hit_input", "cache_miss_input")


def tariff_provenance(rates: object) -> dict:
    selected = {key: number(rates.get(key)) for key in RATE_KEYS if key in rates} if isinstance(rates, Mapping) else {}
    selected = {key: value for key, value in selected.items() if value is not None}
    usable = ({"input", "output"}.issubset(selected)
              or {"cache_hit_input", "cache_miss_input", "output"}.issubset(selected))
    fingerprint = hashlib.sha256(json.dumps(selected, sort_keys=True, separators=(",", ":")).encode()).hexdigest() if usable else None
    return {
        "schema_version": SCHEMA_VERSION,
        "cost_basis": "tariff_estimate",
        "rate_unit": "USD_per_million_tokens",
        "rates": selected,
        "rate_version": f"repository-sha256-{fingerprint}" if fingerprint else None,
        "effective_date": None,
        "effective_date_status": "unknown",
        "freshness": "repository_snapshot_unverified" if usable else "unavailable",
        "settled_billed_cost_usd": None,
    }


def cache_provenance(reported: object, inferred: object) -> dict:
    reported = reported if isinstance(reported, Mapping) else {}
    inferred = inferred if isinstance(inferred, Mapping) else {}
    result = {}
    for key in ("cache_read_input_tokens", "cache_miss_input_tokens"):
        observed = number(reported.get(key), integral=True)
        assumed = number(inferred.get(key), integral=True)
        result[key] = {
            "reported": observed,
            "inferred": assumed,
            "state": "reported" if observed is not None else "inferred" if assumed is not None else "unknown",
        }
    return result
