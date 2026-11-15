from __future__ import annotations

from typing import Any

from .estimators import _safe_project, estimate_data_transfer_cost

TRANSFER_CATEGORY_INTERNET_EGRESS = "internet_egress"
TRANSFER_CATEGORY_INTER_AZ = "inter_az_or_regional"
TRANSFER_CATEGORY_INBOUND = "inbound_or_free"
TRANSFER_CATEGORY_NAT = "nat_or_processing"
TRANSFER_CATEGORY_OTHER = "other_byte_usage"

TRANSFER_CATEGORY_LABELS = {
    TRANSFER_CATEGORY_INTERNET_EGRESS: "Internet transfer out",
    TRANSFER_CATEGORY_INTER_AZ: "Inter-AZ or regional transfer",
    TRANSFER_CATEGORY_INBOUND: "Inbound or free transfer",
    TRANSFER_CATEGORY_NAT: "NAT or byte-processing charges",
    TRANSFER_CATEGORY_OTHER: "Other byte-based usage",
}


def classify_aws_transfer_usage_type(usage_type: str) -> str | None:
    name = (usage_type or "").strip().lower()
    if not name:
        return None

    if not any(
        marker in name
        for marker in ("datatransfer", "data transfer", "bytes", "natgateway", "vpcendpoint")
    ):
        return None

    if any(
        marker in name
        for marker in (
            "natgateway",
            "nat gateway",
            "vpcendpoint",
            "transitgateway",
            "processing-bytes",
            "processed-bytes",
            "processed bytes",
            "gwlb",
            "gateway",
        )
    ):
        return TRANSFER_CATEGORY_NAT

    if any(
        marker in name
        for marker in (
            "xaz",
            "cross-az",
            "crossaz",
            "inter-zone",
            "interzone",
            "inter-region",
            "interregion",
            "regional-bytes",
            "regional bytes",
            "datatransfer-regional",
            "regional data transfer",
        )
    ):
        return TRANSFER_CATEGORY_INTER_AZ

    if any(marker in name for marker in ("datatransfer-in", "data transfer in", "in-bytes")) and "out-bytes" not in name:
        return TRANSFER_CATEGORY_INBOUND

    if any(
        marker in name
        for marker in (
            "datatransfer-out",
            "data transfer out",
            "out-bytes",
            "aws-out-bytes",
        )
    ):
        return TRANSFER_CATEGORY_INTERNET_EGRESS

    if "bytes" in name or "datatransfer" in name or "data transfer" in name:
        return TRANSFER_CATEGORY_OTHER

    return None


def summarize_transfer_usage_types(
    usage_rows: list[dict[str, Any]],
    elapsed_days: int,
    days_in_month: int,
    free_tier_gb: float,
    rate_per_gb: float,
) -> dict[str, Any]:
    totals: dict[str, dict[str, Any]] = {
        key: {
            "key": key,
            "label": TRANSFER_CATEGORY_LABELS[key],
            "monthToDateGb": 0.0,
            "monthToDateCostUsd": 0.0,
            "usageTypes": [],
        }
        for key in TRANSFER_CATEGORY_LABELS
    }

    for row in usage_rows:
        usage_type = str(row.get("name") or "")
        category = classify_aws_transfer_usage_type(usage_type)
        if not category:
            continue
        usage_quantity = float(row.get("usageQuantity") or 0.0)
        cost = float(row.get("cost") or 0.0)
        bucket = totals[category]
        bucket["monthToDateGb"] += max(usage_quantity, 0.0)
        bucket["monthToDateCostUsd"] += max(cost, 0.0)
        bucket["usageTypes"].append(
            {
                "name": usage_type,
                "usageQuantity": round(usage_quantity, 3),
                "cost": round(cost, 2),
            }
        )

    eligible_internet_gb = totals[TRANSFER_CATEGORY_INTERNET_EGRESS]["monthToDateGb"]
    eligible_estimate = estimate_data_transfer_cost(
        eligible_internet_gb,
        elapsed_days,
        days_in_month,
        free_tier_gb,
        rate_per_gb,
    )

    categories: list[dict[str, Any]] = []
    for key, bucket in totals.items():
        month_to_date_gb = float(bucket["monthToDateGb"])
        projected_gb = _safe_project(month_to_date_gb, elapsed_days, days_in_month)
        categories.append(
            {
                "key": key,
                "label": bucket["label"],
                "monthToDateGb": round(month_to_date_gb, 3),
                "projectedMonthEndGb": round(projected_gb, 3),
                "monthToDateCostUsd": round(float(bucket["monthToDateCostUsd"]), 2),
                "usageTypes": bucket["usageTypes"][:5],
            }
        )

    categories.sort(
        key=lambda item: (
            float(item.get("monthToDateGb") or 0),
            float(item.get("monthToDateCostUsd") or 0),
        ),
        reverse=True,
    )
    top_category = next(
        (item for item in categories if float(item.get("monthToDateGb") or 0) > 0),
        None,
    )

    return {
        "categories": categories,
        "eligibleInternetTransferGb": round(eligible_internet_gb, 3),
        "projectedEligibleInternetTransferGb": eligible_estimate["projectedGb"],
        "remainingFreeGb": eligible_estimate["remainingFreeGb"],
        "estimatedOverageGb": eligible_estimate["estimatedOverageGb"],
        "projectedOverageUsd": eligible_estimate["projectedMonthEndCostUsd"],
        "monthToDateOverageUsd": eligible_estimate["monthToDateCostUsd"],
        "topCategoryLabel": top_category["label"] if top_category else None,
    }
