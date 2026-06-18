from __future__ import annotations

import os, time, calendar
from datetime import datetime, timezone
from app.core.logging import get_logger
from .estimators import estimate_data_transfer_cost, estimate_projected_month_end, classify_traffic_path
from .recommendations import generateDataTransferRecommendation, generateTransferFamilyRecommendation, generateUnattachedEbsRecommendation, sort_recommendations

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
    recs = [r for r in [
        generateDataTransferRecommendation({"usedGb": transfer_gb, "projectedGb": transfer["projectedGb"], "source": "mock", "topBandwidthPath": traffic_rows[0]["path"] if traffic_rows else None, "estimatedMonthlySavingsUsd": 12.5}),
        generateTransferFamilyRecommendation({"servers": [], "billingCostUsd": 0, "lastCheckedAt": now.isoformat()}),
        generateUnattachedEbsRecommendation({"volumes": [{"volumeId":"vol-demo1234567890","sizeGb":32,"state":"available","ageDays":14}], "estimatedMonthlySavingsUsd": 3.2, "lastCheckedAt": now.isoformat()}),
    ] if r]
    for rec in recs:
        rec["confidence"] = "demo"
        rec["source"] = "mock"
    recs = sort_recommendations(recs)
    drivers = []
    for idx, s in enumerate(top_services, 1):
        drivers.append({"rank":idx,"driver":s["name"],"source":"Cost Explorer" if idx < 4 else "Inventory estimate","monthToDateCost":s["cost"],"projectedMonthEndCost":estimate_projected_month_end(s["cost"], elapsed, days),"usageQuantity":s["usageQuantity"],"unit":s["unit"],"confidence":"actual" if idx < 4 else "estimated","severity":"high" if idx in (1,5) else "medium","whyItCostsMoney":"AWS bills this resource by usage, storage, processed bytes, or endpoint hours.","suggestedAction":"Review utilization and apply the matching recommendation below.","estimatedMonthlySavings":round(s["cost"]*.35,2),"linkToAWSConsole":"https://console.aws.amazon.com/costmanagement/home?region=us-east-1#/cost-explorer"})
    return {"summary":{"monthToDateAwsCost":mtd_cost,"projectedMonthEndCost":projected,"dataTransferUsedGb":transfer_gb,"freeTransferRemainingGb":transfer["remainingFreeGb"],"estimatedOverageGb":transfer["estimatedOverageGb"],"ec2RunningInstances":1,"unattachedEbsGb":32,"activePublicIpv4Count":1,"activeHighRiskResources":{"transferFamily":1,"natGateways":1,"loadBalancers":1}},"dailyCostTrend":[{"date":f"{now.year}-{now.month:02d}-{d:02d}","cost":round(mtd_cost/elapsed*d/2,2),"projected":round(projected/elapsed*d/2,2)} for d in range(1, elapsed+1)],"dataTransferTrend":[{"date":f"{now.year}-{now.month:02d}-{d:02d}","gb":round(transfer_gb/elapsed*d,2),"freeTierGb":100} for d in range(1, elapsed+1)],"topServices":top_services,"topUsageTypes":[{"name":"DataTransfer-Out-Bytes","cost":18.4,"usageQuantity":transfer_gb,"unit":"GB"},{"name":"BoxUsage:t3.small","cost":12.8,"usageQuantity":420,"unit":"Hrs"},{"name":"EBS:VolumeUsage.gp3","cost":4.9,"usageQuantity":80,"unit":"GB-Mo"}],"costDrivers":drivers,"traffic":traffic_rows,"recommendations":recs,"inventory":{"instances":[{"instanceId":"i-demo123","name":"cred-x-web","instanceType":"t3.small","state":"running","networkOutGb":54.2,"cpuAveragePct":7.1,"publicIpv4":True}],"volumes":[{"volumeId":"vol-demo","sizeGb":32,"type":"gp3","state":"available","unattached":True}],"logGroups":[{"name":"/cred-x/backend","retentionDays":None,"storedGb":2.1}],"missingPermissions":[]},"debug":{"mockMode":True,"demoDataNotice":"Demo data — not real AWS account findings.","lastAwsRefreshTime":_CACHE.get("last_refresh"),"awsRegion":os.getenv("AWS_REGION","ap-south-1"),"costExplorerLabel":"AWS actuals, delayed about 24 hours","cloudWatchLabel":"near-real-time metrics","appLogsLabel":"near-real-time website attribution","cacheTtlSeconds":int(os.getenv("COST_DASHBOARD_CACHE_TTL_SECONDS","3600"))}}

def _empty_live_dashboard() -> dict:
    now = datetime.now(timezone.utc).isoformat()
    return {"summary":{"monthToDateAwsCost":0,"projectedMonthEndCost":0,"dataTransferUsedGb":0,"freeTransferRemainingGb":100,"estimatedOverageGb":0,"ec2RunningInstances":0,"unattachedEbsGb":0,"activePublicIpv4Count":0,"activeHighRiskResources":{}},"dailyCostTrend":[],"dataTransferTrend":[],"topServices":[],"topUsageTypes":[],"costDrivers":[],"traffic":[],"recommendations":[],"inventory":{"instances":[],"volumes":[],"logGroups":[],"missingPermissions":[]},"diagnostics":[{"service":"Cost Explorer","status":"not_checked","message":"Live Cost Explorer collector is not configured in this build."},{"service":"EC2","status":"not_checked","message":"Live EC2 inventory collector is not configured in this build."},{"service":"EBS","status":"not_checked","message":"Live EBS inventory collector is not configured in this build."},{"service":"CloudWatch Logs","status":"not_checked","message":"Live CloudWatch Logs collector is not configured in this build."},{"service":"Transfer Family","status":"not_checked","message":"Live Transfer Family collector is not configured in this build."},{"service":"App traffic logs","status":"unavailable","message":"App traffic logs unavailable."}],"debug":{"mockMode":False,"lastAwsRefreshTime":now,"awsRegion":os.getenv("AWS_REGION","ap-south-1"),"costExplorerLabel":"not checked","cloudWatchLabel":"not checked","appLogsLabel":"unavailable","cacheTtlSeconds":int(os.getenv("COST_DASHBOARD_CACHE_TTL_SECONDS","3600"))}}

def get_dashboard(force_refresh: bool=False) -> dict:
    ttl = int(os.getenv("COST_DASHBOARD_CACHE_TTL_SECONDS", "3600"))
    mock = os.getenv("COST_DASHBOARD_MOCK_MODE", "false").lower() == "true"
    if not force_refresh and _CACHE["data"] and time.time() < float(_CACHE["expires"]):
        return _CACHE["data"]  # type: ignore
    if not mock:
        data = _empty_live_dashboard()
        _CACHE.update({"data": data, "expires": time.time()+ttl, "last_refresh": datetime.now(timezone.utc).isoformat()})
        data["debug"]["lastAwsRefreshTime"] = _CACHE["last_refresh"]
        return data
    data = _mock_dashboard(); data["debug"]["mockMode"] = mock
    _CACHE.update({"data": data, "expires": time.time()+ttl, "last_refresh": datetime.now(timezone.utc).isoformat()})
    data["debug"]["lastAwsRefreshTime"] = _CACHE["last_refresh"]
    return data
