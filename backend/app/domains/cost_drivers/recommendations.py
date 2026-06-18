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


def diagnostic(id: str, title: str, source: Source, evidence: list[dict[str, Any]], last_checked_at: str | None = None) -> dict[str, Any]:
    return recommendation(id, title, "info", "not_checked", source, title, evidence, [], None, last_checked_at)


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
        if billing_cost > 0:
            return recommendation(
                "transfer-family-billing-only",
                "AWS Transfer Family cost detected in billing, but servers could not be listed.",
                "high",
                "confirmed_billing_only",
                "cost_explorer",
                "Cost Explorer shows Transfer Family spend, but the resource inventory check was unavailable.",
                [{"label": "Month-to-date Transfer Family spend", "value": round(billing_cost, 2), "unit": "USD"}],
                ["Check AWS Transfer Family in AWS console."],
                None,
                checked_at,
                "https://console.aws.amazon.com/transfer/home",
            )
        return None
    active = [s for s in servers if str(s.get("state") or s.get("State") or "").upper() in ACTIVE_TRANSFER_STATES]
    if not active:
        return None
    return recommendation(
        "transfer-family-active-server",
        "Active AWS Transfer Family server may create fixed hourly cost",
        "critical",
        "confirmed",
        "ec2_api",
        "Managed SFTP/FTPS/FTP endpoints can create cost even when traffic is low.",
        [
            {"label": "Active servers", "value": len(active)},
            {"label": "Example server IDs", "value": ", ".join(str(s.get("serverId") or s.get("ServerId") or "unknown") for s in active[:3])},
        ],
        ["Confirm whether this Transfer Family server is required.", "If unused, delete it from AWS after owner approval.", "For admin-only transfers, consider SSH/SCP/S3 instead."],
        input.get("estimatedMonthlySavingsUsd"),
        checked_at,
        "https://console.aws.amazon.com/transfer/home",
    )


def generateUnattachedEbsRecommendation(input: dict[str, Any]) -> dict[str, Any] | None:
    if input.get("permissionMissing"):
        return diagnostic("ebs-permission", "EBS volumes were not checked — missing ec2:DescribeVolumes", "ec2_api", [{"label": "Missing permission", "value": "ec2:DescribeVolumes"}], input.get("lastCheckedAt"))
    volumes = input.get("volumes") or []
    available = [v for v in volumes if str(v.get("state") or v.get("State") or "").lower() == "available"]
    if not available:
        return None
    total_gb = sum(float(v.get("sizeGb") or v.get("Size") or 0) for v in available)
    oldest = max((int(v.get("ageDays") or 0) for v in available), default=0)
    ids = ", ".join(str(v.get("volumeId") or v.get("VolumeId") or "unknown")[:8] + "…" for v in available[:3])
    return recommendation("unattached-ebs", "Unattached EBS volumes are incurring storage cost", "medium", "confirmed", "ec2_api", "EBS volumes continue billing while unattached.", [{"label":"Unattached volumes","value":len(available)}, {"label":"Total unattached storage","value":round(total_gb,2),"unit":"GB"}, {"label":"Oldest unattached volume age","value":oldest,"unit":"days"}, {"label":"Example volume IDs","value":ids}], ["Review the listed volume IDs.", "Snapshot first if the data may be needed.", "Delete only after manual owner approval."], input.get("estimatedMonthlySavingsUsd"), input.get("lastCheckedAt"), "https://console.aws.amazon.com/ec2/home#Volumes:")


def generateDataTransferRecommendation(input: dict[str, Any]) -> dict[str, Any] | None:
    used = float(input.get("usedGb") or 0); projected = float(input.get("projectedGb") or 0)
    if used <= DATA_TRANSFER_WARNING_GB and projected <= FREE_TRANSFER_GB:
        return None
    source = input.get("source") or "cost_explorer"
    top_path = input.get("topBandwidthPath")
    evidence = [{"label":"Month-to-date GB","value":round(used,2),"unit":"GB"}, {"label":"Projected month-end GB","value":round(projected,2),"unit":"GB"}, {"label":"Free allowance","value":FREE_TRANSFER_GB,"unit":"GB"}, {"label":"Data source","value":source}]
    if top_path: evidence.append({"label":"Top bandwidth path","value":top_path})
    return recommendation("aws-data-transfer", "Data transfer may exceed monthly allowance", "high", "estimated", source, "Cred-x is approaching the monthly free data transfer allowance. If traffic continues at this pace, AWS may charge for additional outbound transfer.", evidence, ["Open the Top bandwidth paths table.", "Check whether the largest paths are images, videos, API JSON, or bots.", "Enable compression and long-lived cache headers.", "Move large media to CDN/object storage.", "Rate-limit abusive crawlers."], input.get("estimatedMonthlySavingsUsd"), input.get("lastCheckedAt"))


def generateCloudWatchLogsRecommendation(input: dict[str, Any]) -> dict[str, Any] | None: return None

def generatePublicIpv4Recommendation(input: dict[str, Any]) -> dict[str, Any] | None: return None

def generateOversizedEc2Recommendation(input: dict[str, Any]) -> dict[str, Any] | None: return None

_ORDER = {("confirmed","critical"):0,("confirmed","high"):1,("estimated","high"):2,("confirmed","medium"):3,("estimated","medium"):4}
_SEV = {"critical":0,"high":1,"medium":2,"low":3,"info":4}

def sort_recommendations(items: list[dict[str, Any]], diagnostics_enabled: bool = False) -> list[dict[str, Any]]:
    filtered = [r for r in items if diagnostics_enabled or r.get("confidence") != "not_checked"]
    return sorted(filtered, key=lambda r: (_ORDER.get((r.get("confidence"), r.get("severity")), 5 if r.get("severity") != "info" else 7), _SEV.get(r.get("severity"), 9), r.get("title", "")))
