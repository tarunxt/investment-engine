from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".svg", ".ico"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm", ".m4v", ".avi", ".mkv"}
STATIC_EXTENSIONS = {".js", ".css", ".map", ".woff", ".woff2", ".ttf"}
BOT_MARKERS = ("bot", "crawler", "spider", "slurp", "bingpreview", "facebookexternalhit", "whatsapp", "telegrambot")


def _safe_project(value: float, elapsed_days: int, days_in_month: int) -> float:
    if elapsed_days <= 0 or days_in_month <= 0:
        return max(value, 0.0)
    return max(value, 0.0) / elapsed_days * days_in_month


def estimate_projected_month_end(month_to_date_cost: float, elapsed_days: int, days_in_month: int) -> float:
    return round(_safe_project(month_to_date_cost, elapsed_days, days_in_month), 2)


def estimate_data_transfer_cost(gb_month_to_date: float, elapsed_days: int, days_in_month: int, free_tier_gb: float, rate_per_gb: float) -> dict:
    projected_gb = _safe_project(gb_month_to_date, elapsed_days, days_in_month)
    billable_gb = max(gb_month_to_date - free_tier_gb, 0.0)
    projected_billable_gb = max(projected_gb - free_tier_gb, 0.0)
    return {
        "monthToDateGb": round(max(gb_month_to_date, 0.0), 3),
        "projectedGb": round(projected_gb, 3),
        "freeTierGb": free_tier_gb,
        "remainingFreeGb": round(max(free_tier_gb - gb_month_to_date, 0.0), 3),
        "estimatedOverageGb": round(projected_billable_gb, 3),
        "monthToDateCostUsd": round(billable_gb * rate_per_gb, 2),
        "projectedMonthEndCostUsd": round(projected_billable_gb * rate_per_gb, 2),
    }


def estimate_ec2_monthly_cost(hourly_rate: float, running_hours_month_to_date: float, elapsed_days: int, days_in_month: int) -> float:
    projected_hours = _safe_project(running_hours_month_to_date, elapsed_days, days_in_month)
    return round(max(hourly_rate, 0.0) * projected_hours, 2)


def estimate_ebs_cost(size_gb: float, gb_month_rate: float, attached_hours: float) -> float:
    fraction = min(max(attached_hours, 0.0) / (24 * 30), 1.0)
    return round(max(size_gb, 0.0) * max(gb_month_rate, 0.0) * fraction, 2)


def estimate_public_ipv4_cost(ip_count: int, hours: float, rate_per_hour: float) -> float:
    return round(max(ip_count, 0) * max(hours, 0.0) * max(rate_per_hour, 0.0), 2)


def estimate_cloudwatch_logs_cost(ingested_gb: float, stored_gb: float, ingestion_rate: float, storage_rate: float) -> float:
    return round(max(ingested_gb, 0.0) * max(ingestion_rate, 0.0) + max(stored_gb, 0.0) * max(storage_rate, 0.0), 2)


def classify_traffic_path(path: str, content_type: str | None = None, extension: str | None = None, user_agent: str | None = None) -> str:
    ua = (user_agent or "").lower()
    if any(marker in ua for marker in BOT_MARKERS):
        return "bots/crawlers"
    ext = (extension or Path((path or "").split("?", 1)[0]).suffix).lower()
    ct = (content_type or "").lower()
    if ext in IMAGE_EXTENSIONS or ct.startswith("image/"):
        return "images"
    if ext in VIDEO_EXTENSIONS or ct.startswith("video/"):
        return "videos"
    if ext in STATIC_EXTENSIONS or "javascript" in ct or "text/css" in ct:
        return "JavaScript/CSS"
    if (path or "").startswith("/api/") or "application/json" in ct:
        return "API JSON"
    if "text/html" in ct or ext in {"", ".html"}:
        return "HTML pages"
    return "unknown"
