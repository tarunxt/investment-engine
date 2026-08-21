from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

Severity = str
Confidence = str
Source = str

ACTIVE_TRANSFER_STATES = {"ONLINE", "STARTED", "ACTIVE", "RUNNING"}
FREE_TRANSFER_GB = 100.0
DATA_TRANSFER_WARNING_GB = 75.0


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def recommendation(
    id: str,
    title: str,
    severity: Severity,
    confidence: Confidence,
    source: Source,
    why: str,
    evidence: list[dict[str, Any]],
    actions: list[str],
    savings: float | None = None,
    last_checked_at: str | None = None,
    url: str | None = None,
) -> dict[str, Any]:
    if severity == "critical" and confidence != "confirmed":
        severity = "high"
    return {
        "id": id,
        "driverKey": id,
        "title": title,
        "severity": severity,
        "confidence": confidence,
        "source": source,
        "whyThisMatters": why,
        "explanation": why,
        "evidence": evidence,
        "recommendedActions": actions,
        "suggestedAction": " ".join(actions),
        "estimatedMonthlySavingsUsd": savings,
        "lastCheckedAt": last_checked_at or _now(),
        "relatedAwsConsoleUrl": url,
    }


def diagnostic(
    id: str,
    title: str,
    source: Source,
    evidence: list[dict[str, Any]],
    last_checked_at: str | None = None,
) -> dict[str, Any]:
    return recommendation(
        id,
        title,
        "info",
        "not_checked",
        source,
        title,
        evidence,
        [],
        None,
        last_checked_at,
    )


def generateTransferFamilyRecommendation(input: dict[str, Any]) -> dict[str, Any] | None:
    checked_at = input.get("lastCheckedAt")
    if input.get("permissionMissing"):
        return diagnostic(
            "transfer-family-permission",
            "AWS Transfer Family was not checked — missing permission transfer:ListServers",
            "ec2_api",
            [{"label": "Missing permission", "value": "transfer:ListServers"}],
            checked_at,
        )

    servers = input.get("servers")
    billing_cost = float(input.get("billingCostUsd") or 0)
    if servers is None:
        if billing_cost <= 0:
            return None
        return recommendation(
            "transfer-family-billing-only",
            "AWS Transfer Family cost detected in billing, but servers could not be listed.",
            "high",
            "confirmed_billing_only",
            "cost_explorer",
            "Cost Explorer shows Transfer Family spend, but the resource inventory check was unavailable.",
            [
                {
                    "label": "Month-to-date Transfer Family spend",
                    "value": round(billing_cost, 2),
                    "unit": "USD",
                }
            ],
            ["Check AWS Transfer Family in the AWS console."],
            None,
            checked_at,
            "https://console.aws.amazon.com/transfer/home",
        )

    active = [
        server
        for server in servers
        if str(server.get("state") or server.get("State") or "").upper()
        in ACTIVE_TRANSFER_STATES
    ]
    if not active:
        return None

    return recommendation(
        "transfer-family-active-server",
        "Active AWS Transfer Family server may create fixed hourly cost",
        "critical",
        "confirmed",
        "ec2_api",
        "Managed SFTP, FTPS, and FTP endpoints can create cost even when traffic is low.",
        [
            {"label": "Active servers", "value": len(active)},
            {
                "label": "Example server IDs",
                "value": ", ".join(
                    str(server.get("serverId") or server.get("ServerId") or "unknown")
                    for server in active[:3]
                ),
            },
        ],
        [
            "Confirm whether the Transfer Family server is still needed.",
            "If it is unused, delete it only after manual owner approval.",
            "For admin-only transfers, consider SSH, SCP, or direct S3 access.",
        ],
        input.get("estimatedMonthlySavingsUsd"),
        checked_at,
        "https://console.aws.amazon.com/transfer/home",
    )


def generateUnattachedEbsRecommendation(input: dict[str, Any]) -> dict[str, Any] | None:
    checked_at = input.get("lastCheckedAt")
    if input.get("permissionMissing"):
        return diagnostic(
            "ebs-permission",
            "EBS volumes were not checked — missing ec2:DescribeVolumes",
            "ec2_api",
            [{"label": "Missing permission", "value": "ec2:DescribeVolumes"}],
            checked_at,
        )

    volumes = input.get("volumes") or []
    available = [
        volume
        for volume in volumes
        if str(volume.get("state") or volume.get("State") or "").lower() == "available"
    ]
    if not available:
        return None

    total_gb = sum(float(volume.get("sizeGb") or volume.get("Size") or 0) for volume in available)
    oldest_days = max((int(volume.get("ageDays") or 0) for volume in available), default=0)
    sample_ids = ", ".join(
        f"{str(volume.get('volumeId') or volume.get('VolumeId') or 'unknown')[:8]}…"
        for volume in available[:3]
    )
    return recommendation(
        "unattached-ebs",
        "Unattached EBS volumes are incurring storage cost",
        "medium",
        "confirmed",
        "ec2_api",
        "EBS volumes continue billing while unattached.",
        [
            {"label": "Unattached volumes", "value": len(available)},
            {
                "label": "Total unattached storage",
                "value": round(total_gb, 2),
                "unit": "GB",
            },
            {
                "label": "Oldest unattached volume age",
                "value": oldest_days,
                "unit": "days",
            },
            {"label": "Example volume IDs", "value": sample_ids},
        ],
        [
            "Review the listed volume IDs.",
            "Snapshot first if the data might still be needed.",
            "Delete only after manual owner approval.",
        ],
        input.get("estimatedMonthlySavingsUsd"),
        checked_at,
        "https://console.aws.amazon.com/ec2/home#Volumes:",
    )


def generateDataTransferRecommendation(input: dict[str, Any]) -> dict[str, Any] | None:
    used = float(input.get("usedGb") or 0)
    projected = float(input.get("projectedGb") or 0)
    projected_overage_usd = float(input.get("projectedOverageUsd") or 0)
    if used <= DATA_TRANSFER_WARNING_GB and projected <= FREE_TRANSFER_GB:
        return None

    source = input.get("source") or "cost_explorer"
    top_path = input.get("topBandwidthPath")
    categories = input.get("categories") or []
    evidence = [
        {"label": "Eligible internet transfer out", "value": round(used, 2), "unit": "GB"},
        {"label": "Projected eligible transfer out", "value": round(projected, 2), "unit": "GB"},
        {"label": "Free allowance", "value": FREE_TRANSFER_GB, "unit": "GB"},
        {
            "label": "Projected overage",
            "value": round(float(input.get("projectedOverageGb") or 0), 2),
            "unit": "GB",
        },
        {"label": "Projected overage cost", "value": round(projected_overage_usd, 2), "unit": "USD"},
        {"label": "Allowance scope", "value": "Internet transfer out only"},
    ]
    if top_path:
        evidence.append({"label": "Top bandwidth path", "value": top_path})
    if categories:
        evidence.append(
            {
                "label": "Largest tracked transfer class",
                "value": categories[0].get("label") or "unknown",
            }
        )

    return recommendation(
        "aws-data-transfer",
        "Eligible internet egress is trending toward the AWS transfer allowance",
        "high",
        "estimated",
        source,
        "The 100 GB allowance applies only to internet transfer out. Cred-X is trending toward billable internet egress, while other byte usage classes should be reviewed separately.",
        evidence,
        [
            "Open the Top bandwidth routes table and confirm whether images, video, API JSON, HTML, or crawlers dominate egress.",
            "Compress and cache high-volume responses before the allowance is exceeded.",
            "Move large media and static payloads to CDN or object storage where appropriate.",
            "Review non-internet transfer classes such as regional or NAT processing separately because they do not consume the 100 GB allowance.",
        ],
        input.get("estimatedMonthlySavingsUsd") or (projected_overage_usd if projected_overage_usd > 0 else None),
        input.get("lastCheckedAt"),
    )


def generateCloudWatchLogsRecommendation(input: dict[str, Any]) -> dict[str, Any] | None:
    checked_at = input.get("lastCheckedAt")
    if input.get("permissionMissing"):
        return diagnostic(
            "cloudwatch-logs-permission",
            "CloudWatch Logs were not checked — missing logs:DescribeLogGroups",
            "logs_api",
            [{"label": "Missing permission", "value": "logs:DescribeLogGroups"}],
            checked_at,
        )

    groups = input.get("logGroups") or []
    without_retention = [group for group in groups if group.get("retentionDays") in (None, 0)]
    total_stored_gb = sum(float(group.get("storedGb") or 0) for group in groups)
    if not without_retention and total_stored_gb <= 0:
        return None

    return recommendation(
        "cloudwatch-logs-retention",
        "CloudWatch Logs storage should be reviewed for retention and volume",
        "medium",
        "confirmed",
        "logs_api",
        "Stored log volume and missing retention policies can keep log-storage spend growing even when application traffic is flat.",
        [
            {"label": "Log groups checked", "value": len(groups)},
            {"label": "Groups without retention", "value": len(without_retention)},
            {"label": "Stored log volume", "value": round(total_stored_gb, 2), "unit": "GB"},
        ],
        [
            "Set explicit retention on noisy log groups instead of leaving them unbounded.",
            "Reduce duplicate or debug-heavy application logs before changing retention.",
            "Review the runtime resource report to correlate log volume with backend and worker activity.",
        ],
        input.get("estimatedMonthlySavingsUsd"),
        checked_at,
        "https://console.aws.amazon.com/cloudwatch/home#logsV2:log-groups",
    )


def generatePublicIpv4Recommendation(input: dict[str, Any]) -> dict[str, Any] | None:
    checked_at = input.get("lastCheckedAt")
    if input.get("permissionMissing"):
        return diagnostic(
            "public-ipv4-permission",
            "Public IPv4 addresses were not fully checked — missing ec2:DescribeAddresses",
            "ec2_api",
            [{"label": "Missing permission", "value": "ec2:DescribeAddresses"}],
            checked_at,
        )

    ipv4_count = int(input.get("count") or 0)
    if ipv4_count <= 0:
        return None

    return recommendation(
        "public-ipv4",
        "Public IPv4 addresses should be reviewed as a direct monthly cost driver",
        "medium",
        "confirmed",
        "ec2_api",
        "AWS bills public IPv4 addresses directly, so every in-use or attached address should have an owner and a reason to exist.",
        [
            {"label": "Public IPv4 count", "value": ipv4_count},
            {
                "label": "Projected monthly IPv4 cost",
                "value": round(float(input.get("projectedMonthlyCostUsd") or 0), 2),
                "unit": "USD",
            },
        ],
        [
            "Confirm that each public IPv4 address is still required for direct internet reachability.",
            "Prefer a single public entry point such as a load balancer, proxy, or CDN where possible.",
            "Use the runtime resource report to match public IPv4 use with running services before making any changes.",
        ],
        input.get("estimatedMonthlySavingsUsd"),
        checked_at,
        "https://console.aws.amazon.com/ec2/home#Addresses:",
    )


def generateOversizedEc2Recommendation(input: dict[str, Any]) -> dict[str, Any] | None:
    checked_at = input.get("lastCheckedAt")
    if input.get("permissionMissing"):
        return diagnostic(
            "ec2-rightsize-permission",
            "EC2 utilization was not checked — missing cloudwatch:GetMetricStatistics or ec2:DescribeInstances",
            "ec2_api",
            [
                {
                    "label": "Missing permission",
                    "value": "cloudwatch:GetMetricStatistics and/or ec2:DescribeInstances",
                }
            ],
            checked_at,
        )

    instances = input.get("instances") or []
    candidates = [
        instance
        for instance in instances
        if float(instance.get("cpuAveragePct") or 0) <= 15
        and float(instance.get("cpuMaxPct") or 0) <= 45
    ]
    if not candidates:
        return None

    sample = candidates[0]
    return recommendation(
        "ec2-rightsize",
        "One or more EC2 instances look underutilized over the last 7 days",
        "medium",
        "confirmed",
        "ec2_api",
        "CloudWatch CPU averages and peaks suggest that at least one instance may be larger than the current runtime actually needs.",
        [
            {"label": "Underutilized instances", "value": len(candidates)},
            {
                "label": "Example instance",
                "value": f"{sample.get('instanceId', 'unknown')} ({sample.get('instanceType', 'unknown')})",
            },
            {
                "label": "Example CPU average/max",
                "value": f"{round(float(sample.get('cpuAveragePct') or 0), 2)}% / {round(float(sample.get('cpuMaxPct') or 0), 2)}%",
            },
        ],
        [
            "Run deploy/no-docker/scripts/ec2-rightsize-report.sh on the host before considering any instance-size change.",
            "Review memory, swap, disk, and Celery concurrency alongside CPU so a low-CPU host is not memory-bound.",
            "Do not resize production automatically; confirm the owner and rollback path first.",
        ],
        input.get("estimatedMonthlySavingsUsd"),
        checked_at,
        "https://console.aws.amazon.com/ec2/home#Instances:",
    )


def generateLightsailRecommendation(input: dict[str, Any]) -> dict[str, Any] | None:
    checked_at = input.get("lastCheckedAt")
    if input.get("permissionMissing"):
        return diagnostic(
            "lightsail-permission",
            "Lightsail inventory was not checked — missing lightsail:GetInstances or related list permissions",
            "lightsail_api",
            [
                {
                    "label": "Missing permission",
                    "value": "lightsail:GetInstances/GetStaticIps/GetDisks/GetInstanceSnapshots/GetDiskSnapshots",
                }
            ],
            checked_at,
        )

    instances = input.get("instances") or []
    static_ips = input.get("staticIps") or []
    disks = input.get("disks") or []
    snapshots = input.get("snapshots") or []
    billing_cost = float(input.get("billingCostUsd") or 0)
    if not instances and not static_ips and not disks and not snapshots and billing_cost <= 0:
        return None

    return recommendation(
        "lightsail-review",
        "Lightsail resources should be reconciled against current production ownership",
        "medium",
        "confirmed",
        "lightsail_api",
        "Lightsail resources can continue billing even after the primary app moved elsewhere, so inventory should be reviewed against the current Cred-X runtime.",
        [
            {"label": "Lightsail instances", "value": len(instances)},
            {"label": "Lightsail static IPs", "value": len(static_ips)},
            {"label": "Lightsail disks", "value": len(disks)},
            {"label": "Lightsail snapshots", "value": len(snapshots)},
            {"label": "Month-to-date Lightsail spend", "value": round(billing_cost, 2), "unit": "USD"},
        ],
        [
            "Run deploy/no-docker/scripts/lightsail-inventory.sh to capture a read-only inventory before planning any cleanup.",
            "Confirm whether each Lightsail resource still belongs to Cred-X or is leftover from an older deployment path.",
            "Do not stop or delete Lightsail resources automatically from deployment scripts.",
        ],
        input.get("estimatedMonthlySavingsUsd"),
        checked_at,
        "https://lightsail.aws.amazon.com/ls/webapp/home/resources",
    )


def generateCostExplorerRecommendation(input: dict[str, Any]) -> dict[str, Any] | None:
    checked_at = input.get("lastCheckedAt")
    if input.get("permissionMissing"):
        return diagnostic(
            "cost-explorer-permission",
            "Cost Explorer was not checked — missing ce:GetCostAndUsage",
            "cost_explorer",
            [{"label": "Missing permission", "value": "ce:GetCostAndUsage"}],
            checked_at,
        )

    if input.get("loaded"):
        return None

    return recommendation(
        "cost-explorer-unavailable",
        "Cost Explorer data is unavailable, so cost drivers are based on partial evidence",
        "medium",
        "inferred",
        "cost_explorer",
        "Without Cost Explorer actuals, month-to-date service costs and projected AWS spend cannot be verified from billing.",
        [
            {"label": "Observed status", "value": input.get("status") or "unavailable"},
            {
                "label": "Diagnostic message",
                "value": input.get("message") or "No Cost Explorer detail was returned.",
            },
        ],
        [
            "Grant read-only Cost Explorer access such as ce:GetCostAndUsage for the diagnostics role or instance profile.",
            "Keep the last known dashboard snapshot available so temporary AWS failures do not hide cost history.",
            "Use the runtime and Lightsail inventory reports to gather operational evidence while billing access is unavailable.",
        ],
        None,
        checked_at,
        "https://console.aws.amazon.com/costmanagement/home#/cost-explorer",
    )


_ORDER = {
    ("confirmed", "critical"): 0,
    ("confirmed", "high"): 1,
    ("estimated", "high"): 2,
    ("confirmed_billing_only", "high"): 3,
    ("confirmed", "medium"): 4,
    ("inferred", "medium"): 5,
    ("estimated", "medium"): 6,
}
_SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}


def sort_recommendations(
    items: list[dict[str, Any]], diagnostics_enabled: bool = False
) -> list[dict[str, Any]]:
    filtered = [
        item
        for item in items
        if diagnostics_enabled or item.get("confidence") != "not_checked"
    ]
    return sorted(
        filtered,
        key=lambda item: (
            _ORDER.get(
                (str(item.get("confidence")), str(item.get("severity"))),
                99 if item.get("severity") != "info" else 199,
            ),
            _SEVERITY_ORDER.get(str(item.get("severity")), 999),
            str(item.get("title") or ""),
        ),
    )
