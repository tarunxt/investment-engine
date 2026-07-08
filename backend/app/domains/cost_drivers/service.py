from __future__ import annotations

import os, time, calendar
from datetime import datetime, timezone, timedelta, date
from typing import Any
from sqlalchemy import desc
from app.core.logging import get_logger
from app.infrastructure.database.sync_session import SyncSessionLocal
from .estimators import (
    estimate_data_transfer_cost,
    estimate_projected_month_end,
    classify_traffic_path,
)
from .models import TrafficCostRollup
from .recommendations import (
    generateDataTransferRecommendation,
    generateTransferFamilyRecommendation,
    generateUnattachedEbsRecommendation,
    sort_recommendations,
)

logger = get_logger(__name__)
_CACHE: dict[str, dict[str, object]] = {}

FREE_TRANSFER_GB = 100.0
TRANSFER_RATE_PER_GB_DEFAULT = 0.09


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
    region = os.getenv("AWS_REGION", "ap-south-1")
    empty = {
        "mtd_cost": 0.0,
        "top_services": [],
        "top_usage_types": [],
        "daily_cost": [],
        "transfer_gb": 0.0,
    }
    try:
        ce = _aws_client("ce", "us-east-1")
        daily_resp = ce.get_cost_and_usage(
            TimePeriod={"Start": start, "End": end},
            Granularity="DAILY",
            Metrics=["UnblendedCost"],
        )
        daily_cost = [
            {
                "date": r["TimePeriod"]["Start"],
                "cost": round(float(r["Total"]["UnblendedCost"]["Amount"]), 2),
            }
            for r in daily_resp.get("ResultsByTime", [])
        ]
        mtd_cost = round(sum(float(r["cost"]) for r in daily_cost), 2)
        services_resp = ce.get_cost_and_usage(
            TimePeriod={"Start": start, "End": end},
            Granularity="MONTHLY",
            Metrics=["UnblendedCost", "UsageQuantity"],
            GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}],
        )
        services = []
        for g in (services_resp.get("ResultsByTime") or [{}])[0].get("Groups", []):
            cost = float(g["Metrics"]["UnblendedCost"]["Amount"])
            if cost > 0:
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
        transfer_gb = 0.0
        for g in (usage_resp.get("ResultsByTime") or [{}])[0].get("Groups", []):
            name = g["Keys"][0]
            qty = float(g["Metrics"]["UsageQuantity"]["Amount"])
            cost = float(g["Metrics"]["UnblendedCost"]["Amount"])
            if "DataTransfer" in name or "Bytes" in name:
                transfer_gb += max(qty, 0.0)
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
            "mtd_cost": mtd_cost,
            "top_services": services[:8],
            "top_usage_types": usage[:10],
            "daily_cost": daily_cost,
            "transfer_gb": round(transfer_gb, 3),
        }
    except Exception as exc:
        logger.exception("Cost Explorer collection failed")
        diagnostics.append(
            {"service": "Cost Explorer", "status": "error", "message": str(exc)[:300]}
        )
        return empty


def _collect_inventory(diagnostics: list[dict[str, str]]) -> dict[str, Any]:
    region = os.getenv("AWS_REGION", "ap-south-1")
    inventory: dict[str, Any] = {
        "instances": [],
        "volumes": [],
        "logGroups": [],
        "missingPermissions": [],
    }
    try:
        ec2 = _aws_client("ec2", region)
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
                inventory["instances"].append(
                    {
                        "instanceId": inst.get("InstanceId"),
                        "name": name,
                        "instanceType": inst.get("InstanceType"),
                        "state": inst.get("State", {}).get("Name"),
                        "publicIpv4": bool(inst.get("PublicIpAddress")),
                    }
                )
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
    transfer_gb = 89.15
    transfer = estimate_data_transfer_cost(
        transfer_gb,
        elapsed,
        days,
        100,
        _env_float("DATA_TRANSFER_OUT_RATE_PER_GB", 0.09),
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
                    "source": "mock",
                    "topBandwidthPath": (
                        traffic_rows[0]["path"] if traffic_rows else None
                    ),
                    "estimatedMonthlySavingsUsd": 12.5,
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
        ]
        if r
    ]
    for rec in recs:
        rec["confidence"] = "demo"
        rec["source"] = "mock"
    recs = sort_recommendations(recs)
    drivers = []
    for idx, s in enumerate(top_services, 1):
        drivers.append(
            {
                "rank": idx,
                "driver": s["name"],
                "source": "Cost Explorer" if idx < 4 else "Inventory estimate",
                "monthToDateCost": s["cost"],
                "projectedMonthEndCost": estimate_projected_month_end(
                    s["cost"], elapsed, days
                ),
                "usageQuantity": s["usageQuantity"],
                "unit": s["unit"],
                "confidence": "actual" if idx < 4 else "estimated",
                "severity": "high" if idx in (1, 5) else "medium",
                "whyItCostsMoney": "AWS bills this resource by usage, storage, processed bytes, or endpoint hours.",
                "suggestedAction": "Review utilization and apply the matching recommendation below.",
                "estimatedMonthlySavings": round(s["cost"] * 0.35, 2),
                "linkToAWSConsole": "https://console.aws.amazon.com/costmanagement/home?region=us-east-1#/cost-explorer",
            }
        )
    return {
        "summary": {
            "monthToDateAwsCost": mtd_cost,
            "projectedMonthEndCost": projected,
            "dataTransferUsedGb": transfer_gb,
            "freeTransferRemainingGb": transfer["remainingFreeGb"],
            "estimatedOverageGb": transfer["estimatedOverageGb"],
            "ec2RunningInstances": 1,
            "unattachedEbsGb": 32,
            "activePublicIpv4Count": 1,
            "activeHighRiskResources": {
                "transferFamily": 1,
                "natGateways": 1,
                "loadBalancers": 1,
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
        "topUsageTypes": [
            {
                "name": "DataTransfer-Out-Bytes",
                "cost": 18.4,
                "usageQuantity": transfer_gb,
                "unit": "GB",
            },
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
            "missingPermissions": [],
        },
        "debug": {
            "mockMode": True,
            "selectedMonth": selected_month,
            "demoDataNotice": "Demo data — not real AWS account findings.",
            "lastAwsRefreshTime": _CACHE.get("last_refresh"),
            "awsRegion": os.getenv("AWS_REGION", "ap-south-1"),
            "costExplorerLabel": "AWS actuals, delayed about 24 hours",
            "cloudWatchLabel": "near-real-time metrics",
            "appLogsLabel": "near-real-time website attribution",
            "cacheTtlSeconds": int(
                os.getenv("COST_DASHBOARD_CACHE_TTL_SECONDS", "3600")
            ),
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
            "missingPermissions": [],
        },
        "diagnostics": [
            {
                "service": "Cost Explorer",
                "status": "not_checked",
                "message": "Live Cost Explorer collector is not configured in this build.",
            },
            {
                "service": "EC2",
                "status": "not_checked",
                "message": "Live EC2 inventory collector is not configured in this build.",
            },
            {
                "service": "EBS",
                "status": "not_checked",
                "message": "Live EBS inventory collector is not configured in this build.",
            },
            {
                "service": "CloudWatch Logs",
                "status": "not_checked",
                "message": "Live CloudWatch Logs collector is not configured in this build.",
            },
            {
                "service": "Transfer Family",
                "status": "not_checked",
                "message": "Live Transfer Family collector is not configured in this build.",
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
            "cacheTtlSeconds": int(
                os.getenv("COST_DASHBOARD_CACHE_TTL_SECONDS", "3600")
            ),
        },
    }


def _live_dashboard(month: str | None = None) -> dict:
    now, elapsed, days, start_date, end_date, _is_current, selected_month = (
        _month_window(month)
    )
    diagnostics: list[dict[str, str]] = []
    ce = _collect_cost_explorer(now, elapsed, days, diagnostics, start_date, end_date)
    inventory = _collect_inventory(diagnostics)
    start_at = datetime.combine(start_date, datetime.min.time())
    end_at = datetime.combine(end_date, datetime.min.time())
    traffic = _collect_traffic_rollups(diagnostics, start_at, end_at)
    daily_breakdown = _collect_daily_transfer_breakdown(diagnostics, start_at, end_at)
    transfer_gb = max(
        float(ce.get("transfer_gb") or 0),
        sum(float(t.get("totalGB") or 0) for t in traffic),
    )
    transfer = estimate_data_transfer_cost(
        transfer_gb,
        elapsed,
        days,
        FREE_TRANSFER_GB,
        _env_float("DATA_TRANSFER_OUT_RATE_PER_GB", TRANSFER_RATE_PER_GB_DEFAULT),
    )
    mtd_cost = float(ce.get("mtd_cost") or 0)
    projected = estimate_projected_month_end(mtd_cost, elapsed, days)
    top_services = list(ce.get("top_services") or [])
    drivers = []
    for idx, s in enumerate(top_services, 1):
        cost = float(s.get("cost") or 0)
        drivers.append(
            {
                "rank": idx,
                "driver": str(s.get("name") or "AWS service"),
                "source": "Cost Explorer",
                "monthToDateCost": cost,
                "projectedMonthEndCost": estimate_projected_month_end(
                    cost, elapsed, days
                ),
                "usageQuantity": float(s.get("usageQuantity") or 0),
                "unit": str(s.get("unit") or "usage units"),
                "confidence": "actual",
                "severity": "high" if idx <= 2 else "medium",
                "whyItCostsMoney": "AWS Cost Explorer reports month-to-date spend for this service.",
                "suggestedAction": "Review the matching AWS service, usage type, and recommendations below.",
                "estimatedMonthlySavings": round(cost * 0.25, 2),
                "linkToAWSConsole": "https://console.aws.amazon.com/costmanagement/home?region=us-east-1#/cost-explorer",
            }
        )
    unattached_gb = sum(
        float(v.get("sizeGb") or 0) for v in inventory.get("volumes", [])
    )
    public_ipv4 = sum(1 for i in inventory.get("instances", []) if i.get("publicIpv4"))
    recs = [
        r
        for r in [
            generateDataTransferRecommendation(
                {
                    "usedGb": transfer_gb,
                    "projectedGb": transfer["projectedGb"],
                    "source": (
                        "cost_explorer" if ce.get("transfer_gb") else "app_traffic_logs"
                    ),
                    "topBandwidthPath": traffic[0]["path"] if traffic else None,
                }
            ),
            generateUnattachedEbsRecommendation(
                {
                    "volumes": inventory.get("volumes", []),
                    "lastCheckedAt": now.isoformat(),
                }
            ),
        ]
        if r
    ]
    return {
        "summary": {
            "monthToDateAwsCost": mtd_cost,
            "projectedMonthEndCost": projected,
            "dataTransferUsedGb": transfer_gb,
            "freeTransferRemainingGb": transfer["remainingFreeGb"],
            "estimatedOverageGb": transfer["estimatedOverageGb"],
            "ec2RunningInstances": len(inventory.get("instances", [])),
            "unattachedEbsGb": unattached_gb,
            "activePublicIpv4Count": public_ipv4,
            "activeHighRiskResources": {
                "transferFamily": 0,
                "natGateways": 0,
                "loadBalancers": 0,
            },
        },
        "dailyCostTrend": ce.get("daily_cost") or [],
        "dataTransferTrend": (
            _live_data_transfer_trend(now, elapsed, transfer_gb, daily_breakdown)
            if transfer_gb
            else []
        ),
        "topServices": top_services,
        "topUsageTypes": ce.get("top_usage_types") or [],
        "costDrivers": drivers,
        "traffic": traffic,
        "recommendations": sort_recommendations(recs),
        "inventory": inventory,
        "diagnostics": diagnostics,
        "debug": {
            "mockMode": False,
            "selectedMonth": selected_month,
            "lastAwsRefreshTime": None,
            "awsRegion": os.getenv("AWS_REGION", "ap-south-1"),
            "costExplorerLabel": (
                "AWS actuals loaded"
                if ce.get("daily_cost") or top_services
                else "not available — see diagnostics"
            ),
            "cloudWatchLabel": "live checks attempted",
            "appLogsLabel": (
                "database rollups loaded" if traffic else "no traffic rollups stored"
            ),
            "cacheTtlSeconds": int(
                os.getenv("COST_DASHBOARD_CACHE_TTL_SECONDS", "3600")
            ),
            "diagnostics": diagnostics,
        },
    }


def get_dashboard(force_refresh: bool = False, month: str | None = None) -> dict:
    ttl = int(os.getenv("COST_DASHBOARD_CACHE_TTL_SECONDS", "3600"))
    mock = os.getenv("COST_DASHBOARD_MOCK_MODE", "false").lower() == "true"
    _selected, _elapsed, _days, _start, _end, _is_current, selected_month = (
        _month_window(month)
    )
    cache_key = f"{selected_month}:{'mock' if mock else 'live'}"
    cached = _CACHE.get(cache_key)
    if (
        not force_refresh
        and cached
        and cached.get("data")
        and time.time() < float(cached.get("expires", 0))
    ):
        return cached["data"]  # type: ignore
    if not mock:
        data = _live_dashboard(selected_month)
    else:
        data = _mock_dashboard(selected_month)
        data["debug"]["mockMode"] = mock
    last_refresh = datetime.now(timezone.utc).isoformat()
    _CACHE[cache_key] = {
        "data": data,
        "expires": time.time() + ttl,
        "last_refresh": last_refresh,
    }
    data["debug"]["lastAwsRefreshTime"] = last_refresh
    return data
