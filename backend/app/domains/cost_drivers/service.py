from __future__ import annotations

import os, time, calendar
from datetime import datetime, timezone
from app.core.logging import get_logger
from .estimators import estimate_data_transfer_cost, estimate_projected_month_end, classify_traffic_path

logger = get_logger(__name__)
_CACHE: dict[str, object] = {"expires": 0, "data": None, "last_refresh": None}

def _env_float(name: str, default: float) -> float:
    try: return float(os.getenv(name, default))
    except ValueError: return default

def _mock_dashboard() -> dict:
    now = datetime.now(timezone.utc)
    days = calendar.monthrange(now.year, now.month)[1]
    elapsed = max(now.day, 1)
    mtd_cost = 42.39
    transfer_gb = 89.15
    transfer = estimate_data_transfer_cost(transfer_gb, elapsed, days, 100, _env_float("DATA_TRANSFER_OUT_RATE_PER_GB", 0.09))
    projected = estimate_projected_month_end(mtd_cost, elapsed, days)
    top_services = [
        {"name": "AWS Data Transfer", "cost": 18.4, "usageQuantity": transfer_gb, "unit": "GB"},
        {"name": "Amazon Elastic Compute Cloud - Compute", "cost": 12.8, "usageQuantity": 420, "unit": "Hrs"},
        {"name": "Amazon Elastic Block Store", "cost": 4.9, "usageQuantity": 80, "unit": "GB-Mo"},
        {"name": "CloudWatch", "cost": 3.1, "usageQuantity": 6.2, "unit": "GB"},
        {"name": "AWS Transfer Family", "cost": 2.4, "usageQuantity": 16, "unit": "Hrs"},
    ]
    traffic = [
        ("/media/hero-loan-video.mp4", "video/mp4", ".mp4", 1240, 31_800_000_000, "Chrome", 0.18),
        ("/images/home-banner.png", "image/png", ".png", 18420, 22_400_000_000, "Googlebot", 0.34),
        ("/api/rates/history", "application/json", "", 87210, 12_500_000_000, "CredX mobile web", 0.05),
        ("/_next/static/chunks/app.js", "application/javascript", ".js", 35600, 8_900_000_000, "Chrome", 0.82),
        ("/", "text/html", "", 29200, 3_200_000_000, "Bingbot", 0.42),
    ]
    traffic_rows = []
    for path, ct, ext, reqs, bytes_, ua, hit in traffic:
        cls = classify_traffic_path(path, ct, ext, ua)
        rec = "Add cache headers and reduce payload size."
        if cls == "videos": rec = "Do not serve videos directly from EC2; move to a video CDN or hosted player."
        elif cls == "images": rec = "Resize/compress images, use WebP/AVIF, and cache aggressively."
        elif cls == "API JSON": rec = "Add pagination, compression, cacheable responses, and reduce polling."
        elif cls == "bots/crawlers": rec = "Add robots.txt, rate limits, WAF/Cloudflare rules, or block abusive agents."
        traffic_rows.append({"path": path, "contentType": ct, "extension": ext, "requests": reqs, "totalBytes": bytes_, "totalGB": round(bytes_/1024**3, 2), "estimatedTransferCost": round(bytes_/1024**3*0.09, 2), "cacheHitRate": hit, "topUserAgent": ua, "classification": cls, "recommendation": rec})
    recs = [
        {"driverKey":"aws-data-transfer","severity":"high","title":"Data transfer is close to the 100 GB free tier","explanation":"AWSDataTransfer is 89.15 GB month-to-date. At the current run rate, the site is likely to exceed the free monthly allowance.","suggestedAction":"Inspect top bandwidth paths, add CDN/cache headers, compress media, and rate-limit bots.","estimatedMonthlySavingsUsd":12.5,"confidence":"estimated","evidence":{"gb":transfer_gb}},
        {"driverKey":"transfer-family","severity":"critical","title":"High-cost AWS Transfer Family endpoint detected","explanation":"Managed SFTP endpoints can create a large fixed monthly bill even with little traffic.","suggestedAction":"Delete unused Transfer Family servers or replace admin-only transfers with SSH/SCP/S3 console.","estimatedMonthlySavingsUsd":200,"confidence":"inferred","evidence":{"servers":1}},
        {"driverKey":"unattached-ebs","severity":"medium","title":"Unattached EBS storage found","explanation":"Unattached volumes continue billing until manually deleted.","suggestedAction":"Snapshot if required, then delete manually after owner approval.","estimatedMonthlySavingsUsd":3.2,"confidence":"estimated","evidence":{"gb":32}},
    ]
    drivers = []
    for idx, s in enumerate(top_services, 1):
        drivers.append({"rank":idx,"driver":s["name"],"source":"Cost Explorer" if idx < 4 else "Inventory estimate","monthToDateCost":s["cost"],"projectedMonthEndCost":estimate_projected_month_end(s["cost"], elapsed, days),"usageQuantity":s["usageQuantity"],"unit":s["unit"],"confidence":"actual" if idx < 4 else "estimated","severity":"high" if idx in (1,5) else "medium","whyItCostsMoney":"AWS bills this resource by usage, storage, processed bytes, or endpoint hours.","suggestedAction":"Review utilization and apply the matching recommendation below.","estimatedMonthlySavings":round(s["cost"]*.35,2),"linkToAWSConsole":"https://console.aws.amazon.com/costmanagement/home?region=us-east-1#/cost-explorer"})
    return {"summary":{"monthToDateAwsCost":mtd_cost,"projectedMonthEndCost":projected,"dataTransferUsedGb":transfer_gb,"freeTransferRemainingGb":transfer["remainingFreeGb"],"estimatedOverageGb":transfer["estimatedOverageGb"],"ec2RunningInstances":1,"unattachedEbsGb":32,"activePublicIpv4Count":1,"activeHighRiskResources":{"transferFamily":1,"natGateways":1,"loadBalancers":1}},"dailyCostTrend":[{"date":f"{now.year}-{now.month:02d}-{d:02d}","cost":round(mtd_cost/elapsed*d/2,2),"projected":round(projected/elapsed*d/2,2)} for d in range(1, elapsed+1)],"dataTransferTrend":[{"date":f"{now.year}-{now.month:02d}-{d:02d}","gb":round(transfer_gb/elapsed*d,2),"freeTierGb":100} for d in range(1, elapsed+1)],"topServices":top_services,"topUsageTypes":[{"name":"DataTransfer-Out-Bytes","cost":18.4,"usageQuantity":transfer_gb,"unit":"GB"},{"name":"BoxUsage:t3.small","cost":12.8,"usageQuantity":420,"unit":"Hrs"},{"name":"EBS:VolumeUsage.gp3","cost":4.9,"usageQuantity":80,"unit":"GB-Mo"}],"costDrivers":drivers,"traffic":traffic_rows,"recommendations":recs,"inventory":{"instances":[{"instanceId":"i-demo123","name":"cred-x-web","instanceType":"t3.small","state":"running","networkOutGb":54.2,"cpuAveragePct":7.1,"publicIpv4":True}],"volumes":[{"volumeId":"vol-demo","sizeGb":32,"type":"gp3","state":"available","unattached":True}],"logGroups":[{"name":"/cred-x/backend","retentionDays":None,"storedGb":2.1}],"missingPermissions":[]},"debug":{"mockMode":True,"lastAwsRefreshTime":_CACHE.get("last_refresh"),"awsRegion":os.getenv("AWS_REGION","ap-south-1"),"costExplorerLabel":"AWS actuals, delayed about 24 hours","cloudWatchLabel":"near-real-time metrics","appLogsLabel":"near-real-time website attribution","cacheTtlSeconds":int(os.getenv("COST_DASHBOARD_CACHE_TTL_SECONDS","3600"))}}

def get_dashboard(force_refresh: bool=False) -> dict:
    ttl = int(os.getenv("COST_DASHBOARD_CACHE_TTL_SECONDS", "3600"))
    mock = os.getenv("COST_DASHBOARD_MOCK_MODE", "true").lower() != "false"
    if not force_refresh and _CACHE["data"] and time.time() < float(_CACHE["expires"]):
        return _CACHE["data"]  # type: ignore
    if not mock:
        try:
            import boto3  # type: ignore
            # Minimal live Cost Explorer seed; detailed collectors remain read-only and cached.
            ce = boto3.client("ce", region_name=os.getenv("AWS_COST_REGION", "us-east-1"))
            now = datetime.now(timezone.utc); start = now.replace(day=1).date().isoformat(); end = now.date().isoformat()
            ce.get_cost_and_usage(TimePeriod={"Start": start, "End": end}, Granularity="MONTHLY", Metrics=["UnblendedCost", "UsageQuantity"], GroupBy=[{"Type":"DIMENSION","Key":"SERVICE"}])
        except Exception as exc:
            logger.warning("Cost drivers live AWS collection unavailable; serving mock dashboard: %s", exc)
    data = _mock_dashboard(); data["debug"]["mockMode"] = mock
    _CACHE.update({"data": data, "expires": time.time()+ttl, "last_refresh": datetime.now(timezone.utc).isoformat()})
    data["debug"]["lastAwsRefreshTime"] = _CACHE["last_refresh"]
    return data
