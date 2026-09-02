from __future__ import annotations

import calendar
import os
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy import desc

from app.core.logging import get_logger
from app.infrastructure.database.sync_session import SyncSessionLocal

from .cache import (
    claim_refresh_cooldown,
    dashboard_cache_ttl_seconds,
    load_cached_dashboard,
    load_stale_good_dashboard,
    store_dashboard,
)
from .estimators import classify_traffic_path, estimate_data_transfer_cost, estimate_projected_month_end
from .models import TrafficCostRollup
from .recommendations import (
    generateCloudWatchLogsRecommendation,
    generateCostExplorerRecommendation,
    generateDataTransferRecommendation,
    generateLightsailRecommendation,
    generateOversizedEc2Recommendation,
    generatePublicIpv4Recommendation,
    generateTransferFamilyRecommendation,
    generateUnattachedEbsRecommendation,
    sort_recommendations,
)
from .transfer import summarize_transfer_usage_types

logger = get_logger(__name__)

FREE_TRANSFER_GB = 100.0
TRANSFER_RATE_PER_GB_DEFAULT = 0.09
PUBLIC_IPV4_RATE_PER_HOUR_DEFAULT = 0.005
CLOUDWATCH_LOG_STORAGE_RATE_PER_GB_DEFAULT = 0.03


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except ValueError:
        return default


def _month_window(
    month: str | None = None,
) -> tuple[datetime, int, int, date, date, bool, str]:
    now = datetime.now(timezone.utc)
    if month:
        try:
            year, month_number = (int(part) for part in month.split("-", 1))
            selected = datetime(year, month_number, 1, tzinfo=timezone.utc)
        except (ValueError, TypeError):
            raise ValueError("month must use YYYY-MM format")
    else:
        selected = now.replace(day=1)
    selected = selected.replace(hour=0, minute=0, second=0, microsecond=0)
    days = calendar.monthrange(selected.year, selected.month)[1]
    is_current_month = selected.year == now.year and selected.month == now.month
    elapsed = max(now.day, 1) if is_current_month else days
    start = selected.date()
    if is_current_month:
        end = now.date() + timedelta(days=1)
    else:
        end = (selected.replace(day=days) + timedelta(days=1)).date()
    return (
        selected,
        elapsed,
        days,
        start,
        end,
        is_current_month,
        f"{selected.year}-{selected.month:02d}",
    )


def _aws_client(service: str, region: str):
    try:
        import boto3  # type: ignore
        from botocore.config import Config  # type: ignore
    except Exception as exc:
        raise RuntimeError("boto3 is not installed in the backend image") from exc
    return boto3.client(
        service,
        region_name=region,
        config=Config(connect_timeout=3, read_timeout=8, retries={"max_attempts": 2}),
    )


def _metric_summary(cloudwatch: Any, instance_id: str, metric_name: str) -> dict[str, float] | None:
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=7)
    response = cloudwatch.get_metric_statistics(
        Namespace="AWS/EC2",
        MetricName=metric_name,
        Dimensions=[{"Name": "InstanceId", "Value": instance_id}],
        StartTime=start,
        EndTime=end,
        Period=3600,
        Statistics=["Average", "Maximum"],
    )
    datapoints = response.get("Datapoints", [])
    if not datapoints:
        return None

    averages = [float(point["Average"]) for point in datapoints if "Average" in point]
    maximums = [float(point["Maximum"]) for point in datapoints if "Maximum" in point]
    if not averages and not maximums:
        return None

    summary: dict[str, float] = {}
    if averages:
        summary["average"] = round(sum(averages) / len(averages), 2)
    if maximums:
        summary["maximum"] = round(max(maximums), 2)
    return summary


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except ValueError:
        return default


def _public_ipv4_monthly_cost(count: int, days_in_month: int) -> float:
    projected_hours = max(days_in_month, 0) * 24
    return round(
        max(count, 0)
        * projected_hours
        * _env_float("PUBLIC_IPV4_RATE_PER_HOUR", PUBLIC_IPV4_RATE_PER_HOUR_DEFAULT),
        2,
    )


def _public_ipv4_billed_cost(usage_rows: list[dict[str, Any]]) -> float:
    """Return only Public IPv4 cost that Cost Explorer actually itemised.

    An attached public address is inventory evidence, not billing evidence.  Keep
    the two separate so a theoretical list-price exposure is never presented as
    an already-paid or immediately removable charge.
    """
    markers = (
        "publicipv4",
        "public-ipv4",
        "inuseaddress",
        "idleaddress",
        "ipaddress",
    )
    return round(
        sum(
            float(row.get("cost") or 0)
            for row in usage_rows
            if any(marker in str(row.get("name") or "").lower() for marker in markers)
        ),
        2,
    )


def _cloudwatch_storage_monthly_cost(stored_gb: float) -> float:
    return round(
        max(stored_gb, 0.0)
        * _env_float(
            "CLOUDWATCH_LOG_STORAGE_RATE_PER_GB",
            CLOUDWATCH_LOG_STORAGE_RATE_PER_GB_DEFAULT,
        ),
        2,
    )


def _estimated_unattached_ebs_savings(volumes: list[dict[str, Any]]) -> float | None:
    total_gb = sum(float(volume.get("sizeGb") or 0) for volume in volumes)
    if total_gb <= 0:
        return None
    rate = _env_float("EBS_GP3_STORAGE_RATE_PER_GB_MONTH", 0.08)
    return round(total_gb * rate, 2)


def _service_savings_profile(
    service_name: str,
    inventory: dict[str, Any],
    transfer_summary: dict[str, Any],
    recommendation_index: dict[str, dict[str, Any]],
    days_in_month: int,
) -> tuple[float, str, str]:
    lowered = service_name.lower()

    if "tax" in lowered:
        return 0.0, "$0.00", "Tax savings require reducing the taxable underlying services."

    if "data transfer" in lowered:
        projected = float(transfer_summary.get("projectedOverageUsd") or 0)
        if projected > 0:
            return projected, f"${projected:.2f}", "Projected billable internet egress overage."
        return 0.0, "$0.00", "No projected internet-transfer overage is currently estimated."

    if "public ipv4" in lowered or "ipv4" in lowered:
        rec = recommendation_index.get("public-ipv4")
        if rec and rec.get("estimatedMonthlySavingsUsd") is not None:
            savings = float(rec["estimatedMonthlySavingsUsd"])
            return savings, f"${savings:.2f}", "Direct public IPv4 monthly charge."
        return 0.0, "Not enough data", "No evidence-backed IPv4 savings estimate is available."

    if "elastic block store" in lowered or lowered.startswith("amazon ebs") or " ebs" in lowered:
        rec = recommendation_index.get("unattached-ebs")
        if rec and rec.get("estimatedMonthlySavingsUsd") is not None:
            savings = float(rec["estimatedMonthlySavingsUsd"])
            return savings, f"${savings:.2f}", "Savings from removing unattached EBS volumes."
        return 0.0, "Not enough data", "No unattached EBS savings estimate is available."

    if "cloudwatch" in lowered:
        rec = recommendation_index.get("cloudwatch-logs-retention")
        if rec and rec.get("estimatedMonthlySavingsUsd") is not None:
            savings = float(rec["estimatedMonthlySavingsUsd"])
            return savings, f"${savings:.2f}", "Estimated log-storage reduction opportunity."
        return 0.0, "Not enough data", "CloudWatch savings depend on retention and ingestion evidence."

    if "lightsail" in lowered:
        rec = recommendation_index.get("lightsail-review")
        if rec and rec.get("estimatedMonthlySavingsUsd") is not None:
            savings = float(rec["estimatedMonthlySavingsUsd"])
            return savings, f"${savings:.2f}", "Evidence-backed Lightsail savings estimate."
        return 0.0, "Not enough data", "Lightsail savings need ownership and usage evidence."

    if "compute" in lowered or "elastic compute cloud" in lowered or lowered.startswith("amazon ec2"):
        rec = recommendation_index.get("ec2-rightsize")
        if rec and rec.get("estimatedMonthlySavingsUsd") is not None:
            savings = float(rec["estimatedMonthlySavingsUsd"])
            return savings, f"${savings:.2f}", "Evidence-backed EC2 right-size estimate."
        return 0.0, "Not enough data", "EC2 savings need utilization and memory evidence."

    return 0.0, "Not enough data", "No evidence-backed savings estimate is available for this service."


def _build_cost_driver_rows(
    top_services: list[dict[str, Any]],
    inventory: dict[str, Any],
    transfer_summary: dict[str, Any],
    recommendations: list[dict[str, Any]],
    elapsed_days: int,
    days_in_month: int,
) -> list[dict[str, Any]]:
    recommendation_index = {
        str(item.get("driverKey") or item.get("id") or ""): item for item in recommendations
    }
    drivers: list[dict[str, Any]] = []
    for index, service in enumerate(top_services, 1):
        cost = float(service.get("cost") or 0)
        driver_name = str(service.get("name") or "AWS service")
        estimated_savings, savings_display, savings_reason = _service_savings_profile(
            driver_name,
            inventory,
            transfer_summary,
            recommendation_index,
            days_in_month,
        )
        drivers.append(
            {
                "rank": index,
                "driver": driver_name,
                "source": "Cost Explorer",
                "monthToDateCost": cost,
                "projectedMonthEndCost": estimate_projected_month_end(
                    cost, elapsed_days, days_in_month
                ),
                "usageQuantity": float(service.get("usageQuantity") or 0),
                "unit": str(service.get("unit") or "usage units"),
                "confidence": "actual",
                "severity": "high" if index <= 2 else "medium",
                "whyItCostsMoney": "AWS Cost Explorer reports month-to-date spend for this service.",
                "suggestedAction": "Review the matching AWS service, usage type, and recommendations below.",
                "estimatedMonthlySavings": estimated_savings,
                "estimatedMonthlySavingsDisplay": savings_display,
                "estimatedMonthlySavingsReason": savings_reason,
                "linkToAWSConsole": "https://console.aws.amazon.com/costmanagement/home?region=us-east-1#/cost-explorer",
            }
        )
    return drivers


def _cost_explorer_diagnostic(diagnostics: list[dict[str, str]]) -> dict[str, str]:
    return next(
        (
            item
            for item in diagnostics
            if str(item.get("service") or "") == "Cost Explorer"
        ),
        {"service": "Cost Explorer", "status": "unknown", "message": "Not checked."},
    )


def _collect_cost_explorer(
    now: datetime,
    elapsed: int,
    days: int,
    diagnostics: list[dict[str, str]],
    start_date: date,
    end_date: date,
) -> dict[str, Any]:
    start = start_date.isoformat()
    end = end_date.isoformat()
    empty = {
        "loaded": False,
        "mtd_cost": 0.0,
        "top_services": [],
        "top_usage_types": [],
        "daily_cost": [],
        "transfer_summary": summarize_transfer_usage_types(
            [],
            elapsed,
            days,
            FREE_TRANSFER_GB,
            _env_float("DATA_TRANSFER_OUT_RATE_PER_GB", TRANSFER_RATE_PER_GB_DEFAULT),
        ),
    }
    try:
        ce = _aws_client("ce", "us-east-1")
        daily_resp = ce.get_cost_and_usage(
            TimePeriod={"Start": start, "End": end},
            Granularity="DAILY",
            Metrics=["UnblendedCost"],
        )
        daily_results = daily_resp.get("ResultsByTime", [])
        daily_cost = [
            {
                "date": r["TimePeriod"]["Start"],
                "cost": round(float(r["Total"]["UnblendedCost"]["Amount"]), 2),
            }
            for r in daily_results
        ]
        # Do not sum the display-rounded daily figures: the rounding loss made a
        # closed August bill appear as $87.65 instead of AWS's $87.72 total.
        mtd_cost = round(
            sum(float(r["Total"]["UnblendedCost"]["Amount"]) for r in daily_results),
            2,
        )
        services_resp = ce.get_cost_and_usage(
            TimePeriod={"Start": start, "End": end},
            Granularity="MONTHLY",
            Metrics=["UnblendedCost", "UsageQuantity"],
            GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}],
        )
        services = []
        for g in (services_resp.get("ResultsByTime") or [{}])[0].get("Groups", []):
            cost = float(g["Metrics"]["UnblendedCost"]["Amount"])
            if cost != 0:
                services.append(
                    {
                        "name": g["Keys"][0],
                        "cost": round(cost, 2),
                        "usageQuantity": round(
                            float(g["Metrics"]["UsageQuantity"]["Amount"]), 3
                        ),
                        "unit": "mixed",
                    }
                )
        services.sort(key=lambda x: x["cost"], reverse=True)
        usage_resp = ce.get_cost_and_usage(
            TimePeriod={"Start": start, "End": end},
            Granularity="MONTHLY",
            Metrics=["UnblendedCost", "UsageQuantity"],
            GroupBy=[{"Type": "DIMENSION", "Key": "USAGE_TYPE"}],
        )
        usage = []
        for g in (usage_resp.get("ResultsByTime") or [{}])[0].get("Groups", []):
            name = g["Keys"][0]
            qty = float(g["Metrics"]["UsageQuantity"]["Amount"])
            cost = float(g["Metrics"]["UnblendedCost"]["Amount"])
            if cost > 0 or qty > 0:
                usage.append(
                    {
                        "name": name,
                        "cost": round(cost, 2),
                        "usageQuantity": round(qty, 3),
                        "unit": "usage units",
                    }
                )
        usage.sort(key=lambda x: (x["cost"], x["usageQuantity"]), reverse=True)
        diagnostics.append(
            {
                "service": "Cost Explorer",
                "status": "ok",
                "message": "Loaded live AWS billing data.",
            }
        )
        return {
            "loaded": True,
            "mtd_cost": mtd_cost,
            "top_services": services[:12],
            "top_usage_types": usage[:25],
            "daily_cost": daily_cost,
            "transfer_summary": summarize_transfer_usage_types(
                usage,
                elapsed,
                days,
                FREE_TRANSFER_GB,
                _env_float(
                    "DATA_TRANSFER_OUT_RATE_PER_GB",
                    TRANSFER_RATE_PER_GB_DEFAULT,
                ),
            ),
        }
    except Exception as exc:
        logger.exception("Cost Explorer collection failed")
        diagnostics.append(
            {"service": "Cost Explorer", "status": "error", "message": str(exc)[:300]}
        )
        return empty


def _collect_inventory(diagnostics: list[dict[str, str]]) -> dict[str, Any]:
    region = os.getenv("AWS_REGION", "ap-south-1")
    configured_regions = [
        value.strip()
        for value in os.getenv(
            "COST_DASHBOARD_AWS_REGIONS", f"{region},eu-west-1"
        ).split(",")
        if value.strip()
    ]
    audit_regions = list(dict.fromkeys([region, *configured_regions]))
    inventory: dict[str, Any] = {
        "region": region,
        "regions": audit_regions,
        "instances": [],
        "volumes": [],
        "logGroups": [],
        "publicIpv4Addresses": [],
        "lightsail": {
            "instances": [],
            "staticIps": [],
            "disks": [],
            "snapshots": [],
        },
        "missingPermissions": [],
    }
    try:
        ec2 = _aws_client("ec2", region)
        cloudwatch = None
        metrics_error_reported = False
        try:
            cloudwatch = _aws_client("cloudwatch", region)
        except Exception as exc:
            logger.exception("CloudWatch metrics collector setup failed")
            diagnostics.append(
                {
                    "service": "EC2 CloudWatch metrics",
                    "status": "error",
                    "message": str(exc)[:300],
                }
            )
            inventory["missingPermissions"].append("cloudwatch:GetMetricStatistics")
        reservations = ec2.describe_instances(
            Filters=[{"Name": "instance-state-name", "Values": ["running"]}]
        ).get("Reservations", [])
        for res in reservations:
            for inst in res.get("Instances", []):
                name = next(
                    (
                        t.get("Value")
                        for t in inst.get("Tags", [])
                        if t.get("Key") == "Name"
                    ),
                    "",
                )
                row = {
                    "instanceId": inst.get("InstanceId"),
                    "name": name,
                    "instanceType": inst.get("InstanceType"),
                    "state": inst.get("State", {}).get("Name"),
                    "availabilityZone": inst.get("Placement", {}).get("AvailabilityZone"),
                    "publicIpv4": bool(inst.get("PublicIpAddress")),
                    "publicIpAddress": inst.get("PublicIpAddress"),
                }
                if cloudwatch is not None and inst.get("InstanceId"):
                    try:
                        cpu_stats = _metric_summary(
                            cloudwatch, str(inst.get("InstanceId")), "CPUUtilization"
                        )
                        if cpu_stats:
                            row["cpuAveragePct"] = cpu_stats.get("average")
                            row["cpuMaxPct"] = cpu_stats.get("maximum")
                        if str(inst.get("InstanceType") or "").startswith("t"):
                            credit_stats = _metric_summary(
                                cloudwatch,
                                str(inst.get("InstanceId")),
                                "CPUCreditBalance",
                            )
                            if credit_stats:
                                row["cpuCreditBalanceAvg"] = credit_stats.get("average")
                                row["cpuCreditBalanceMax"] = credit_stats.get("maximum")
                    except Exception as exc:
                        logger.exception("EC2 CloudWatch metric collection failed")
                        if not metrics_error_reported:
                            diagnostics.append(
                                {
                                    "service": "EC2 CloudWatch metrics",
                                    "status": "error",
                                    "message": str(exc)[:300],
                                }
                            )
                            metrics_error_reported = True
                        if "cloudwatch:GetMetricStatistics" not in inventory["missingPermissions"]:
                            inventory["missingPermissions"].append("cloudwatch:GetMetricStatistics")
                inventory["instances"].append(row)
        volumes = ec2.describe_volumes(
            Filters=[{"Name": "status", "Values": ["available"]}]
        ).get("Volumes", [])
        now = datetime.now(timezone.utc)
        for vol in volumes:
            age = (
                (now - vol.get("CreateTime", now)).days if vol.get("CreateTime") else 0
            )
            inventory["volumes"].append(
                {
                    "volumeId": vol.get("VolumeId"),
                    "sizeGb": vol.get("Size", 0),
                    "state": vol.get("State"),
                    "type": vol.get("VolumeType"),
                    "ageDays": age,
                    "unattached": True,
                }
            )
        try:
            addresses = ec2.describe_addresses().get("Addresses", [])
            inventory["publicIpv4Addresses"] = [
                {
                    "publicIp": address.get("PublicIp"),
                    "allocationId": address.get("AllocationId"),
                    "associationId": address.get("AssociationId"),
                    "instanceId": address.get("InstanceId"),
                }
                for address in addresses
            ]
        except Exception as exc:
            logger.exception("Public IPv4 inventory collection failed")
            diagnostics.append(
                {
                    "service": "Public IPv4",
                    "status": "error",
                    "message": str(exc)[:300],
                }
            )
            inventory["missingPermissions"].append("ec2:DescribeAddresses")
        diagnostics.append(
            {
                "service": "EC2/EBS",
                "status": "ok",
                "message": "Loaded live instance and unattached volume inventory.",
            }
        )
    except Exception as exc:
        logger.exception("EC2/EBS inventory collection failed")
        diagnostics.append(
            {"service": "EC2/EBS", "status": "error", "message": str(exc)[:300]}
        )
        inventory["missingPermissions"].append(
            "ec2:DescribeInstances/ec2:DescribeVolumes"
        )
    try:
        logs = _aws_client("logs", region)
        groups = logs.describe_log_groups(limit=20).get("logGroups", [])
        inventory["logGroups"] = [
            {
                "name": g.get("logGroupName"),
                "retentionDays": g.get("retentionInDays"),
                "storedGb": round(float(g.get("storedBytes", 0)) / 1024**3, 3),
            }
            for g in groups
        ]
        diagnostics.append(
            {
                "service": "CloudWatch Logs",
                "status": "ok",
                "message": "Loaded live log group inventory.",
            }
        )
    except Exception as exc:
        logger.exception("CloudWatch Logs collection failed")
        diagnostics.append(
            {"service": "CloudWatch Logs", "status": "error", "message": str(exc)[:300]}
        )
        inventory["missingPermissions"].append("logs:DescribeLogGroups")
    lightsail_regions_loaded: list[str] = []
    for lightsail_region in audit_regions:
        try:
            lightsail = _aws_client("lightsail", lightsail_region)

            def tagged(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
                return [{**row, "auditRegion": lightsail_region} for row in rows]

            inventory["lightsail"]["instances"].extend(
                tagged(lightsail.get_instances().get("instances", []))
            )
            inventory["lightsail"]["staticIps"].extend(
                tagged(lightsail.get_static_ips().get("staticIps", []))
            )
            inventory["lightsail"]["disks"].extend(
                tagged(lightsail.get_disks().get("disks", []))
            )
            inventory["lightsail"]["snapshots"].extend(
                tagged(
                    lightsail.get_instance_snapshots().get("instanceSnapshots", [])
                    + lightsail.get_disk_snapshots().get("diskSnapshots", [])
                )
            )
            lightsail_regions_loaded.append(lightsail_region)
        except Exception as exc:
            logger.exception("Lightsail inventory collection failed in %s", lightsail_region)
            diagnostics.append(
                {
                    "service": f"Lightsail ({lightsail_region})",
                    "status": "error",
                    "message": str(exc)[:300],
                }
            )
    if lightsail_regions_loaded:
        diagnostics.append(
            {
                "service": "Lightsail",
                "status": "ok",
                "message": "Loaded read-only Lightsail inventory in "
                + ", ".join(lightsail_regions_loaded)
                + ".",
            }
        )
    else:
        inventory["missingPermissions"].append(
            "lightsail:GetInstances/GetStaticIps/GetDisks/GetInstanceSnapshots/GetDiskSnapshots"
        )
    return inventory


def _collect_traffic_rollups(
    diagnostics: list[dict[str, str]],
    start_at: datetime | None = None,
    end_at: datetime | None = None,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        db = SyncSessionLocal()
        try:
            query = db.query(TrafficCostRollup)
            if start_at is not None and end_at is not None:
                query = query.filter(
                    TrafficCostRollup.period_start < end_at,
                    TrafficCostRollup.period_end >= start_at,
                )
            records = (
                query.order_by(
                    desc(TrafficCostRollup.period_end),
                    desc(TrafficCostRollup.response_bytes),
                )
                .limit(20)
                .all()
            )
        finally:
            db.close()
        for r in records:
            total_gb = round((r.response_bytes or 0) / 1024**3, 2)
            cls = classify_traffic_path(
                r.path, r.content_type, r.extension, r.top_user_agent
            )
            rows.append(
                {
                    "path": r.path,
                    "contentType": r.content_type or "unknown",
                    "extension": r.extension or "",
                    "requests": r.request_count,
                    "totalBytes": r.response_bytes,
                    "totalGB": total_gb,
                    "estimatedTransferCost": round(
                        float(
                            r.estimated_transfer_cost_usd
                            or total_gb
                            * _env_float(
                                "DATA_TRANSFER_OUT_RATE_PER_GB",
                                TRANSFER_RATE_PER_GB_DEFAULT,
                            )
                        ),
                        2,
                    ),
                    "cacheHitRate": round(
                        (r.cache_hit_count or 0) / max(r.request_count or 0, 1), 3
                    ),
                    "topUserAgent": r.top_user_agent or "unknown",
                    "classification": cls,
                    "recommendation": _traffic_recommendation(cls),
                }
            )
        diagnostics.append(
            {
                "service": "App traffic logs",
                "status": "ok" if rows else "empty",
                "message": (
                    "Loaded traffic rollups from database."
                    if rows
                    else "No traffic rollups have been stored yet."
                ),
            }
        )
    except Exception as exc:
        logger.exception("Traffic rollup collection failed")
        diagnostics.append(
            {
                "service": "App traffic logs",
                "status": "error",
                "message": str(exc)[:300],
            }
        )
    return rows


def _traffic_recommendation(cls: str) -> str:
    if cls == "videos":
        return "Move videos to a video CDN or hosted player."
    if cls == "images":
        return "Resize/compress images, use WebP/AVIF, and cache aggressively."
    if cls == "API JSON":
        return "Add pagination, compression, cacheable responses, and reduce polling."
    if cls == "bots/crawlers":
        return "Add robots.txt, rate limits, WAF/Cloudflare rules, or block abusive agents."
    return "Add cache headers and reduce payload size."


def _rollup_breakdown_item(
    label: str, bytes_: float, requests: int = 0, paths: set[str] | None = None
) -> dict[str, Any]:
    return {
        "classification": label,
        "totalBytes": int(bytes_),
        "totalGB": round(bytes_ / 1024**3, 2),
        "requests": int(requests),
        "topPaths": sorted(paths or set())[:3],
    }


def _mock_daily_transfer_trend(
    now: datetime, elapsed: int, transfer_gb: float
) -> list[dict[str, Any]]:
    categories = [
        ("API JSON", 0.48),
        ("JavaScript/assets", 0.25),
        ("bots/crawlers", 0.16),
        ("HTML/pages", 0.11),
    ]
    rows: list[dict[str, Any]] = []
    for day in range(1, elapsed + 1):
        cumulative_gb = round(transfer_gb / elapsed * day, 2)
        daily_gb = transfer_gb / elapsed
        breakdown = [
            _rollup_breakdown_item(
                label, daily_gb * share * 1024**3, int(10000 * share)
            )
            for label, share in categories
        ]
        rows.append(
            {
                "date": f"{now.year}-{now.month:02d}-{day:02d}",
                "gb": cumulative_gb,
                "dailyGB": round(daily_gb, 2),
                "freeTierGb": 100,
                "breakdown": breakdown,
            }
        )
    return rows


def _collect_daily_transfer_breakdown(
    diagnostics: list[dict[str, str]], start_at: datetime, end_at: datetime
) -> dict[str, list[dict[str, Any]]]:
    daily: dict[str, dict[str, dict[str, Any]]] = {}
    try:
        db = SyncSessionLocal()
        try:
            records = (
                db.query(TrafficCostRollup)
                .filter(
                    TrafficCostRollup.period_start < end_at,
                    TrafficCostRollup.period_end >= start_at,
                )
                .all()
            )
        finally:
            db.close()
        for r in records:
            day = r.period_start.date().isoformat()
            cls = classify_traffic_path(
                r.path, r.content_type, r.extension, r.top_user_agent
            )
            bucket = daily.setdefault(day, {}).setdefault(
                cls, {"bytes": 0, "requests": 0, "paths": set()}
            )
            bucket["bytes"] += int(r.response_bytes or 0)
            bucket["requests"] += int(r.request_count or 0)
            if r.path:
                bucket["paths"].add(r.path)
        return {
            day: [
                _rollup_breakdown_item(
                    cls, item["bytes"], item["requests"], item["paths"]
                )
                for cls, item in sorted(
                    classes.items(), key=lambda pair: pair[1]["bytes"], reverse=True
                )
            ]
            for day, classes in daily.items()
        }
    except Exception as exc:
        logger.exception("Daily transfer breakdown collection failed")
        diagnostics.append(
            {
                "service": "Daily transfer breakdown",
                "status": "error",
                "message": str(exc)[:300],
            }
        )
        return {}


def _live_data_transfer_trend(
    now: datetime,
    elapsed: int,
    transfer_gb: float,
    daily_breakdown: dict[str, list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    cumulative_from_logs = 0.0
    for day in range(1, elapsed + 1):
        date_key = f"{now.year}-{now.month:02d}-{day:02d}"
        breakdown = daily_breakdown.get(date_key, [])
        logged_daily_gb = round(
            sum(float(item.get("totalGB") or 0) for item in breakdown), 2
        )
        cumulative_from_logs += logged_daily_gb
        cumulative_gb = round(
            cumulative_from_logs if daily_breakdown else transfer_gb / elapsed * day, 2
        )
        rows.append(
            {
                "date": date_key,
                "gb": cumulative_gb,
                "dailyGB": (
                    logged_daily_gb if breakdown else round(transfer_gb / elapsed, 2)
                ),
                "freeTierGb": FREE_TRANSFER_GB,
                "breakdown": breakdown,
            }
        )
    return rows


def _mock_dashboard(month: str | None = None) -> dict:
    now, elapsed, days, _start, _end, _is_current, selected_month = _month_window(month)
    mtd_cost = 42.39
    top_usage_types = [
        {
            "name": "DataTransfer-Out-Bytes",
            "cost": 18.4,
            "usageQuantity": 89.15,
            "unit": "GB",
        },
        {
            "name": "APS1-DataTransfer-xAZ-Out-Bytes",
            "cost": 2.6,
            "usageQuantity": 17.8,
            "unit": "GB",
        },
        {
            "name": "NatGateway-Bytes",
            "cost": 1.9,
            "usageQuantity": 14.2,
            "unit": "GB",
        },
    ]
    transfer_summary = summarize_transfer_usage_types(
        top_usage_types,
        elapsed,
        days,
        FREE_TRANSFER_GB,
        _env_float("DATA_TRANSFER_OUT_RATE_PER_GB", TRANSFER_RATE_PER_GB_DEFAULT),
    )
    transfer_gb = float(transfer_summary.get("eligibleInternetTransferGb") or 0)
    transfer = estimate_data_transfer_cost(
        transfer_gb,
        elapsed,
        days,
        FREE_TRANSFER_GB,
        _env_float("DATA_TRANSFER_OUT_RATE_PER_GB", TRANSFER_RATE_PER_GB_DEFAULT),
    )
    projected = estimate_projected_month_end(mtd_cost, elapsed, days)
    top_services = [
        {
            "name": "AWS Data Transfer",
            "cost": 18.4,
            "usageQuantity": transfer_gb,
            "unit": "GB",
        },
        {
            "name": "Amazon Elastic Compute Cloud - Compute",
            "cost": 12.8,
            "usageQuantity": 420,
            "unit": "Hrs",
        },
        {
            "name": "Amazon Elastic Block Store",
            "cost": 4.9,
            "usageQuantity": 80,
            "unit": "GB-Mo",
        },
        {"name": "CloudWatch", "cost": 3.1, "usageQuantity": 6.2, "unit": "GB"},
        {
            "name": "AWS Transfer Family",
            "cost": 2.4,
            "usageQuantity": 16,
            "unit": "Hrs",
        },
    ]
    traffic = [
        (
            "/api/rates/history",
            "application/json",
            "",
            87210,
            12_500_000_000,
            "CredX mobile web",
            0.05,
        ),
        (
            "/_next/static/chunks/app.js",
            "application/javascript",
            ".js",
            35600,
            8_900_000_000,
            "Chrome",
            0.82,
        ),
        ("/", "text/html", "", 29200, 3_200_000_000, "Bingbot", 0.42),
    ]
    traffic_rows = []
    for path, ct, ext, reqs, bytes_, ua, hit in traffic:
        cls = classify_traffic_path(path, ct, ext, ua)
        rec = "Add cache headers and reduce payload size."
        if cls == "videos":
            rec = "Do not serve videos directly from EC2; move to a video CDN or hosted player."
        elif cls == "images":
            rec = "Resize/compress images, use WebP/AVIF, and cache aggressively."
        elif cls == "API JSON":
            rec = (
                "Add pagination, compression, cacheable responses, and reduce polling."
            )
        elif cls == "bots/crawlers":
            rec = "Add robots.txt, rate limits, WAF/Cloudflare rules, or block abusive agents."
        traffic_rows.append(
            {
                "path": path,
                "contentType": ct,
                "extension": ext,
                "requests": reqs,
                "totalBytes": bytes_,
                "totalGB": round(bytes_ / 1024**3, 2),
                "estimatedTransferCost": round(bytes_ / 1024**3 * 0.09, 2),
                "cacheHitRate": hit,
                "topUserAgent": ua,
                "classification": cls,
                "recommendation": rec,
            }
        )
    recs = [
        r
        for r in [
            generateDataTransferRecommendation(
                {
                    "usedGb": transfer_gb,
                    "projectedGb": transfer["projectedGb"],
                    "projectedOverageGb": transfer_summary["estimatedOverageGb"],
                    "projectedOverageUsd": transfer_summary["projectedOverageUsd"],
                    "categories": transfer_summary["categories"],
                    "source": "mock",
                    "topBandwidthPath": (
                        traffic_rows[0]["path"] if traffic_rows else None
                    ),
                    "estimatedMonthlySavingsUsd": transfer_summary["projectedOverageUsd"],
                }
            ),
            generateTransferFamilyRecommendation(
                {"servers": [], "billingCostUsd": 0, "lastCheckedAt": now.isoformat()}
            ),
            generateUnattachedEbsRecommendation(
                {
                    "volumes": [
                        {
                            "volumeId": "vol-demo1234567890",
                            "sizeGb": 32,
                            "state": "available",
                            "ageDays": 14,
                        }
                    ],
                    "estimatedMonthlySavingsUsd": 3.2,
                    "lastCheckedAt": now.isoformat(),
                }
            ),
            generateCloudWatchLogsRecommendation(
                {
                    "logGroups": [
                        {"name": "/cred-x/backend", "retentionDays": None, "storedGb": 2.1}
                    ],
                    "estimatedMonthlySavingsUsd": 0.06,
                    "lastCheckedAt": now.isoformat(),
                }
            ),
            generatePublicIpv4Recommendation(
                {
                    "count": 1,
                    "projectedMonthlyCostUsd": _public_ipv4_monthly_cost(1, days),
                    "estimatedMonthlySavingsUsd": _public_ipv4_monthly_cost(1, days),
                    "lastCheckedAt": now.isoformat(),
                }
            ),
            generateOversizedEc2Recommendation(
                {
                    "instances": [
                        {
                            "instanceId": "i-demo123",
                            "instanceType": "t3.small",
                            "cpuAveragePct": 7.1,
                            "cpuMaxPct": 18.4,
                        }
                    ],
                    "lastCheckedAt": now.isoformat(),
                }
            ),
            generateLightsailRecommendation(
                {
                    "instances": [],
                    "staticIps": [{"name": "legacy-prod-ip"}],
                    "disks": [{"name": "legacy-prod-disk"}],
                    "snapshots": [{"name": "legacy-prod-snapshot"}],
                    "billingCostUsd": 4.5,
                    "lastCheckedAt": now.isoformat(),
                }
            ),
        ]
        if r
    ]
    for rec in recs:
        rec["confidence"] = "demo"
        rec["source"] = "mock"
    recs = sort_recommendations(recs)
    drivers = _build_cost_driver_rows(
        top_services,
        {
            "instances": [
                {
                    "instanceId": "i-demo123",
                    "name": "cred-x-web",
                    "instanceType": "t3.small",
                    "state": "running",
                    "networkOutGb": 54.2,
                    "cpuAveragePct": 7.1,
                    "cpuMaxPct": 18.4,
                    "publicIpv4": True,
                }
            ],
            "volumes": [
                {
                    "volumeId": "vol-demo",
                    "sizeGb": 32,
                    "type": "gp3",
                    "state": "available",
                    "unattached": True,
                }
            ],
        },
        transfer_summary,
        recs,
        elapsed,
        days,
    )
    return {
        "summary": {
            "monthToDateAwsCost": mtd_cost,
            "projectedMonthEndCost": projected,
            "dataTransferUsedGb": transfer_gb,
            "freeTransferRemainingGb": transfer["remainingFreeGb"],
            "estimatedOverageGb": transfer["estimatedOverageGb"],
            "projectedOverageUsd": transfer_summary["projectedOverageUsd"],
            "ec2RunningInstances": 1,
            "unattachedEbsGb": 32,
            "activePublicIpv4Count": 1,
            "activeHighRiskResources": {
                "transferFamily": 1,
                "natGateways": 1,
                "lightsail": 1,
            },
        },
        "dailyCostTrend": [
            {
                "date": f"{now.year}-{now.month:02d}-{d:02d}",
                "cost": round(mtd_cost / elapsed * d / 2, 2),
                "projected": round(projected / elapsed * d / 2, 2),
            }
            for d in range(1, elapsed + 1)
        ],
        "dataTransferTrend": _mock_daily_transfer_trend(now, elapsed, transfer_gb),
        "topServices": top_services,
        "topUsageTypes": top_usage_types
        + [
            {
                "name": "BoxUsage:t3.small",
                "cost": 12.8,
                "usageQuantity": 420,
                "unit": "Hrs",
            },
            {
                "name": "EBS:VolumeUsage.gp3",
                "cost": 4.9,
                "usageQuantity": 80,
                "unit": "GB-Mo",
            },
        ],
        "costDrivers": drivers,
        "traffic": traffic_rows,
        "recommendations": recs,
        "inventory": {
            "instances": [
                {
                    "instanceId": "i-demo123",
                    "name": "cred-x-web",
                    "instanceType": "t3.small",
                    "state": "running",
                    "networkOutGb": 54.2,
                    "cpuAveragePct": 7.1,
                    "cpuMaxPct": 18.4,
                    "publicIpv4": True,
                }
            ],
            "volumes": [
                {
                    "volumeId": "vol-demo",
                    "sizeGb": 32,
                    "type": "gp3",
                    "state": "available",
                    "unattached": True,
                }
            ],
            "logGroups": [
                {"name": "/cred-x/backend", "retentionDays": None, "storedGb": 2.1}
            ],
            "publicIpv4Addresses": [{"publicIp": "203.0.113.10"}],
            "lightsail": {
                "instances": [],
                "staticIps": [{"name": "legacy-prod-ip"}],
                "disks": [{"name": "legacy-prod-disk"}],
                "snapshots": [{"name": "legacy-prod-snapshot"}],
            },
            "missingPermissions": [],
        },
        "debug": {
            "mockMode": True,
            "selectedMonth": selected_month,
            "demoDataNotice": "Demo data — not real AWS account findings.",
            "lastAwsRefreshTime": None,
            "awsRegion": os.getenv("AWS_REGION", "ap-south-1"),
            "costExplorerLabel": "AWS actuals, delayed about 24 hours",
            "cloudWatchLabel": "near-real-time metrics",
            "appLogsLabel": "near-real-time website attribution",
            "cacheTtlSeconds": dashboard_cache_ttl_seconds(_is_current),
            "transferCategorySummary": transfer_summary["categories"],
        },
    }


def _empty_live_dashboard(month: str | None = None) -> dict:
    selected, _elapsed, _days, _start, _end, _is_current, selected_month = (
        _month_window(month)
    )
    now = datetime.now(timezone.utc).isoformat()
    return {
        "summary": {
            "monthToDateAwsCost": 0,
            "projectedMonthEndCost": 0,
            "dataTransferUsedGb": 0,
            "freeTransferRemainingGb": 100,
            "estimatedOverageGb": 0,
            "projectedOverageUsd": 0,
            "ec2RunningInstances": 0,
            "unattachedEbsGb": 0,
            "activePublicIpv4Count": 0,
            "activeHighRiskResources": {},
        },
        "dailyCostTrend": [],
        "dataTransferTrend": [],
        "topServices": [],
        "topUsageTypes": [],
        "costDrivers": [],
        "traffic": [],
        "recommendations": [],
        "inventory": {
            "instances": [],
            "volumes": [],
            "logGroups": [],
            "publicIpv4Addresses": [],
            "lightsail": {
                "instances": [],
                "staticIps": [],
                "disks": [],
                "snapshots": [],
            },
            "missingPermissions": [],
        },
        "diagnostics": [
            {
                "service": "Cost Explorer",
                "status": "not_checked",
                "message": "Live Cost Explorer data is unavailable in the current response.",
            },
            {
                "service": "EC2",
                "status": "not_checked",
                "message": "Live EC2 inventory data is unavailable in the current response.",
            },
            {
                "service": "EBS",
                "status": "not_checked",
                "message": "Live EBS inventory data is unavailable in the current response.",
            },
            {
                "service": "CloudWatch Logs",
                "status": "not_checked",
                "message": "Live CloudWatch Logs data is unavailable in the current response.",
            },
            {
                "service": "Transfer Family",
                "status": "not_checked",
                "message": "Live Transfer Family data is unavailable in the current response.",
            },
            {
                "service": "App traffic logs",
                "status": "unavailable",
                "message": "App traffic logs unavailable.",
            },
        ],
        "debug": {
            "mockMode": False,
            "selectedMonth": selected_month,
            "lastAwsRefreshTime": now,
            "awsRegion": os.getenv("AWS_REGION", "ap-south-1"),
            "costExplorerLabel": "not checked",
            "cloudWatchLabel": "not checked",
            "appLogsLabel": "unavailable",
            "cacheTtlSeconds": dashboard_cache_ttl_seconds(_is_current),
        },
    }


def _should_use_stale_dashboard(
    current: dict[str, Any], stale_record: dict[str, Any] | None
) -> bool:
    if stale_record is None:
        return False
    if current.get("topServices"):
        return False

    diagnostics = current.get("diagnostics") or []
    return any(
        str(item.get("service") or "") == "Cost Explorer"
        and str(item.get("status") or "") == "error"
        for item in diagnostics
    )


def _annotate_stale_dashboard(
    data: dict[str, Any],
    cached_at: str | None,
    diagnostics: list[dict[str, str]],
    ttl_seconds: int,
) -> dict[str, Any]:
    stale = {**data}
    stale_debug = {**(data.get("debug") or {})}
    stale_debug["servedStaleData"] = True
    stale_debug["staleReason"] = "AWS live refresh failed; returning the last known good dashboard snapshot."
    stale_debug["lastAwsRefreshTime"] = cached_at
    stale_debug["cacheTtlSeconds"] = ttl_seconds
    stale["debug"] = stale_debug
    stale["diagnostics"] = diagnostics + [
        {
            "service": "Shared cache",
            "status": "stale",
            "message": "Served the last known good dashboard snapshot after a live AWS refresh failure.",
        }
    ]
    return stale


def _live_dashboard(month: str | None = None) -> dict:
    now, elapsed, days, start_date, end_date, is_current_month, selected_month = (
        _month_window(month)
    )
    diagnostics: list[dict[str, str]] = []
    ce = _collect_cost_explorer(now, elapsed, days, diagnostics, start_date, end_date)
    inventory = _collect_inventory(diagnostics)
    start_at = datetime.combine(start_date, datetime.min.time())
    end_at = datetime.combine(end_date, datetime.min.time())
    traffic = _collect_traffic_rollups(diagnostics, start_at, end_at)
    daily_breakdown = _collect_daily_transfer_breakdown(diagnostics, start_at, end_at)

    traffic_transfer_gb = sum(float(item.get("totalGB") or 0) for item in traffic)
    transfer_summary = dict(ce.get("transfer_summary") or {})
    eligible_transfer_gb = max(
        float(transfer_summary.get("eligibleInternetTransferGb") or 0),
        traffic_transfer_gb,
    )
    transfer = estimate_data_transfer_cost(
        eligible_transfer_gb,
        elapsed,
        days,
        FREE_TRANSFER_GB,
        _env_float("DATA_TRANSFER_OUT_RATE_PER_GB", TRANSFER_RATE_PER_GB_DEFAULT),
    )
    transfer_summary["eligibleInternetTransferGb"] = round(eligible_transfer_gb, 3)
    transfer_summary["projectedEligibleInternetTransferGb"] = transfer["projectedGb"]
    transfer_summary["remainingFreeGb"] = transfer["remainingFreeGb"]
    transfer_summary["estimatedOverageGb"] = transfer["estimatedOverageGb"]
    transfer_summary["projectedOverageUsd"] = transfer["projectedMonthEndCostUsd"]
    transfer_summary.setdefault("categories", [])

    mtd_cost = float(ce.get("mtd_cost") or 0)
    projected = estimate_projected_month_end(mtd_cost, elapsed, days)
    top_services = list(ce.get("top_services") or [])
    top_usage_types = list(ce.get("top_usage_types") or [])
    public_ipv4_count = max(
        len(inventory.get("publicIpv4Addresses") or []),
        sum(1 for instance in inventory.get("instances", []) if instance.get("publicIpv4")),
    )
    public_ipv4_billed_cost = _public_ipv4_billed_cost(top_usage_types)
    unattached_volumes = list(inventory.get("volumes") or [])
    unattached_gb = sum(float(volume.get("sizeGb") or 0) for volume in unattached_volumes)
    lightsail_inventory = dict(inventory.get("lightsail") or {})
    logs = list(inventory.get("logGroups") or [])
    logs_without_retention = [
        group for group in logs if group.get("retentionDays") in (None, 0)
    ]
    logs_without_retention_gb = sum(
        float(group.get("storedGb") or 0) for group in logs_without_retention
    )
    now_iso = now.isoformat()
    cost_explorer_diag = _cost_explorer_diagnostic(diagnostics)

    recs = [
        recommendation
        for recommendation in [
            generateCostExplorerRecommendation(
                {
                    "loaded": bool(ce.get("loaded")),
                    "status": cost_explorer_diag.get("status"),
                    "message": cost_explorer_diag.get("message"),
                    "lastCheckedAt": now_iso,
                }
            ),
            generateDataTransferRecommendation(
                {
                    "usedGb": eligible_transfer_gb,
                    "projectedGb": transfer["projectedGb"],
                    "projectedOverageGb": transfer_summary.get("estimatedOverageGb"),
                    "projectedOverageUsd": transfer_summary.get("projectedOverageUsd"),
                    "categories": transfer_summary.get("categories") or [],
                    "source": "cost_explorer" if ce.get("loaded") else "app_traffic_logs",
                    "topBandwidthPath": traffic[0]["path"] if traffic else None,
                    "estimatedMonthlySavingsUsd": transfer_summary.get("projectedOverageUsd"),
                    "lastCheckedAt": now_iso,
                }
            ),
            generateUnattachedEbsRecommendation(
                {
                    "volumes": unattached_volumes,
                    "estimatedMonthlySavingsUsd": _estimated_unattached_ebs_savings(unattached_volumes),
                    "lastCheckedAt": now_iso,
                }
            ),
            generateCloudWatchLogsRecommendation(
                {
                    "logGroups": logs,
                    "estimatedMonthlySavingsUsd": _cloudwatch_storage_monthly_cost(
                        logs_without_retention_gb
                    )
                    if logs_without_retention_gb > 0
                    else None,
                    "lastCheckedAt": now_iso,
                }
            ),
            generatePublicIpv4Recommendation(
                {
                    "count": public_ipv4_count,
                    "projectedMonthlyCostUsd": _public_ipv4_monthly_cost(public_ipv4_count, days),
                    "billedCostUsd": public_ipv4_billed_cost,
                    # Inventory proves that an address exists, but not that it is
                    # unnecessary. Savings remain unclaimed until both billing
                    # and the production dependency are verified.
                    "estimatedMonthlySavingsUsd": None,
                    "lastCheckedAt": now_iso,
                }
            ),
            generateOversizedEc2Recommendation(
                {
                    "instances": inventory.get("instances") or [],
                    "lastCheckedAt": now_iso,
                }
            ),
            generateLightsailRecommendation(
                {
                    "instances": lightsail_inventory.get("instances") or [],
                    "staticIps": lightsail_inventory.get("staticIps") or [],
                    "disks": lightsail_inventory.get("disks") or [],
                    "snapshots": lightsail_inventory.get("snapshots") or [],
                    "billingCostUsd": next(
                        (
                            float(service.get("cost") or 0)
                            for service in top_services
                            if "lightsail" in str(service.get("name") or "").lower()
                        ),
                        0.0,
                    ),
                    "lastCheckedAt": now_iso,
                }
            ),
        ]
        if recommendation
    ]
    recommendations = sort_recommendations(recs)
    drivers = _build_cost_driver_rows(
        top_services,
        inventory,
        transfer_summary,
        recommendations,
        elapsed,
        days,
    )

    return {
        "summary": {
            "monthToDateAwsCost": mtd_cost,
            "projectedMonthEndCost": projected,
            "dataTransferUsedGb": eligible_transfer_gb,
            "freeTransferRemainingGb": transfer["remainingFreeGb"],
            "estimatedOverageGb": transfer["estimatedOverageGb"],
            "projectedOverageUsd": transfer["projectedMonthEndCostUsd"],
            "ec2RunningInstances": len(inventory.get("instances", [])),
            "unattachedEbsGb": unattached_gb,
            "activePublicIpv4Count": public_ipv4_count,
            "publicIpv4BilledCostUsd": public_ipv4_billed_cost,
            "activeHighRiskResources": {
                "transferFamily": 0,
                "natGateways": int(
                    any(
                        category.get("key") == "nat_or_processing"
                        and float(category.get("monthToDateGb") or 0) > 0
                        for category in transfer_summary.get("categories") or []
                    )
                ),
                "lightsail": len(lightsail_inventory.get("instances") or []),
            },
        },
        "dailyCostTrend": ce.get("daily_cost") or [],
        "dataTransferTrend": (
            _live_data_transfer_trend(now, elapsed, eligible_transfer_gb, daily_breakdown)
            if eligible_transfer_gb
            else []
        ),
        "topServices": top_services,
        "topUsageTypes": top_usage_types,
        "costDrivers": drivers,
        "traffic": traffic,
        "recommendations": recommendations,
        "inventory": inventory,
        "diagnostics": diagnostics,
        "debug": {
            "mockMode": False,
            "selectedMonth": selected_month,
            "lastAwsRefreshTime": None,
            "awsRegion": os.getenv("AWS_REGION", "ap-south-1"),
            "costExplorerLabel": (
                "AWS actuals loaded"
                if ce.get("loaded")
                else "not available — see diagnostics"
            ),
            "cloudWatchLabel": "7-day EC2 metrics and log-group checks attempted",
            "appLogsLabel": (
                "database rollups loaded" if traffic else "no traffic rollups stored"
            ),
            "cacheTtlSeconds": dashboard_cache_ttl_seconds(is_current_month),
            "diagnostics": diagnostics,
            "transferCategorySummary": transfer_summary.get("categories") or [],
        },
    }


def get_dashboard(force_refresh: bool = False, month: str | None = None) -> dict:
    mock = os.getenv("COST_DASHBOARD_MOCK_MODE", "false").lower() == "true"
    (
        _selected,
        _elapsed,
        _days,
        _start,
        _end,
        is_current_month,
        selected_month,
    ) = _month_window(month)
    ttl_seconds = dashboard_cache_ttl_seconds(is_current_month)
    cache_key = f"{selected_month}:{'mock' if mock else 'live'}"

    if force_refresh:
        claim_refresh_cooldown(cache_key)
    else:
        cached = load_cached_dashboard(cache_key)
        if cached is not None:
            cached.data.setdefault("debug", {})
            cached.data["debug"]["lastAwsRefreshTime"] = cached.cached_at
            cached.data["debug"]["cacheTtlSeconds"] = ttl_seconds
            cached.data["debug"]["servedStaleData"] = False
            return cached.data

    if mock:
        data = _mock_dashboard(selected_month)
        data["debug"]["mockMode"] = True
    else:
        data = _live_dashboard(selected_month)
        stale = load_stale_good_dashboard(cache_key)
        if _should_use_stale_dashboard(
            data,
            stale.data if stale is not None else None,
        ):
            return _annotate_stale_dashboard(
                stale.data,
                stale.cached_at if stale is not None else None,
                list(data.get("diagnostics") or []),
                ttl_seconds,
            )

    cached_at = store_dashboard(cache_key, data, ttl_seconds)
    data.setdefault("debug", {})
    data["debug"]["lastAwsRefreshTime"] = cached_at
    data["debug"]["cacheTtlSeconds"] = ttl_seconds
    data["debug"]["servedStaleData"] = False
    return data
