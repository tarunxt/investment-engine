from __future__ import annotations
from pydantic import BaseModel
from typing import Any, Literal

class CostDriver(BaseModel):
    rank: int
    driver: str
    source: str
    monthToDateCost: float
    projectedMonthEndCost: float
    usageQuantity: float
    unit: str
    confidence: Literal["actual", "estimated", "inferred"]
    severity: Literal["low", "medium", "high", "critical"]
    whyItCostsMoney: str
    suggestedAction: str
    estimatedMonthlySavings: float
    linkToAWSConsole: str | None = None

class TrafficRollup(BaseModel):
    path: str
    contentType: str
    extension: str
    requests: int
    totalBytes: int
    totalGB: float
    estimatedTransferCost: float
    cacheHitRate: float
    topUserAgent: str
    classification: str
    recommendation: str

class Recommendation(BaseModel):
    driverKey: str
    severity: str
    title: str
    explanation: str
    suggestedAction: str
    estimatedMonthlySavingsUsd: float
    confidence: str
    evidence: dict[str, Any] = {}

class CostDriversDashboard(BaseModel):
    summary: dict[str, Any]
    dailyCostTrend: list[dict[str, Any]]
    dataTransferTrend: list[dict[str, Any]]
    topServices: list[dict[str, Any]]
    topUsageTypes: list[dict[str, Any]]
    costDrivers: list[CostDriver]
    traffic: list[TrafficRollup]
    recommendations: list[Recommendation]
    inventory: dict[str, Any]
    debug: dict[str, Any]
