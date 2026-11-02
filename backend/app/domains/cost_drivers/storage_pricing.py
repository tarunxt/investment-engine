"""Versioned public list-price examples, never invoice or approved savings."""
from decimal import Decimal, InvalidOperation

TARIFF_VERSION = "2026-11-01"
SOURCE = "https://aws.amazon.com/ebs/pricing/"
# Retained audit calculator example; unsupported tariffs deliberately stay unknown.
RATES = {
    ("ap-south-1", "gp3"): ("0.0912", None, None),
}
EXCLUSIONS = "Taxes, snapshots, requests, credits and discounts excluded; actual bill unreconciled. Retained backups are not approved removable capacity."


def nonnegative(value):
    result = Decimal(str(value))
    if not result.is_finite() or result < 0:
        raise ValueError("Expected finite nonnegative quantity")
    return result


def estimate_storage(volumes, override=None, override_source=None, override_date=None):
    rows, total = [], Decimal(0)
    for volume in volumes:
        region, kind = volume.get("region"), volume.get("type")
        row = {"region": region, "type": kind, "sizeGb": volume.get("sizeGb"),
               "iops": volume.get("iops"), "throughput": volume.get("throughput"),
               "state": "unpriced", "grossMonthlyExposureUsd": None}
        try:
            size = nonnegative(volume.get("sizeGb"))
            rates = RATES.get((region, kind))
            if not rates:
                raise ValueError("Unsupported region/type tariff")
            storage_rate, iops_rate, throughput_rate = rates
            if override is not None:
                if kind != "gp3" or not override_source or not override_date:
                    raise ValueError("Override requires gp3 and source/effective date")
                storage_rate = str(nonnegative(override))
            cost = size * Decimal(storage_rate)
            if kind == "gp3":
                # Unknown provisioned extras must not be priced as baseline.
                iops, throughput = nonnegative(volume.get("iops")), nonnegative(volume.get("throughput"))
                if (iops > 3000 and iops_rate is None) or (throughput > 125 and throughput_rate is None):
                    raise ValueError("Provisioned extras tariff unavailable")
                if iops > 3000:
                    cost += (iops - 3000) * Decimal(iops_rate)
                if throughput > 125:
                    cost += (throughput - 125) * Decimal(throughput_rate)
            row.update({"state": "priced", "grossMonthlyExposureUsd": str(cost),
                        "storageRateUsdPerGbMonth": storage_rate, "source": override_source if override is not None else SOURCE,
                        "effectiveDate": override_date if override is not None else TARIFF_VERSION})
            total += cost
        except (ValueError, TypeError, InvalidOperation) as exc:
            row["reason"] = str(exc)
        rows.append(row)
    complete = all(row["state"] == "priced" for row in rows)
    return {"state": "priced" if complete else "partial" if any(r["state"] == "priced" for r in rows) else "unpriced",
            "grossMonthlyExposureUsd": str(total) if complete else None,
            "approvedRemovableSavingsUsd": None, "actualBillUsd": None,
            "tariffVersion": TARIFF_VERSION, "source": SOURCE, "rateEvidence": "Audit A12-006 retained public Mumbai calculator example, 2026-11-01; extras tariffs unverified", "exclusions": EXCLUSIONS, "volumes": rows}
