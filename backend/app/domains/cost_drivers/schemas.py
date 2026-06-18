from __future__ import annotations
from pydantic import BaseModel, Field
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

class EvidenceItem(BaseModel):
    label: str
    value: str | int | float
    unit: str | None = None

class Recommendation(BaseModel):
    id: str | None = None
    driverKey: str
    title: str
    severity: Literal["critical", "high", "medium", "low", "info"]
    confidence: Literal["confirmed", "confirmed_billing_only", "estimated", "inferred", "not_checked", "demo"]
    source: Literal["cost_explorer", "cloudwatch", "ec2_api", "logs_api", "app_traffic_logs", "mock"]
    whyThisMatters: str | None = None
    explanation: str
    evidence: list[EvidenceItem] = Field(default_factory=list)
    recommendedActions: list[str] = Field(default_factory=list)
    suggestedAction: str = ""
    estimatedMonthlySavingsUsd: float | None = None
    lastCheckedAt: str | None = None
    relatedAwsConsoleUrl: str | None = None

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
