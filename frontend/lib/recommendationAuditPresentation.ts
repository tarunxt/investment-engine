import type { AuditComparison, AuditDecision, AuditFinding, AuditScoreInput } from "@/types/recommendationAudit";
import { getScoreMatrixRowEffectiveMultiplier } from "@/lib/scoreMatrixMath";

export function auditNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function formatAuditNumber(value: unknown, signed = false) {
  const number = auditNumber(value);
  if (number === null) return "Unknown";
  const rounded = Math.round((number + Number.EPSILON) * 100) / 100;
  return `${signed && rounded > 0 ? "+" : ""}${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(Object.is(rounded, -0) ? 0 : rounded)}`;
}

export function formatAuditTime(value: unknown) {
  if (typeof value !== "string" || !value) return "Unknown";
  const date = new Date(value.endsWith("Z") || /[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`);
  if (!Number.isFinite(date.getTime())) return "Unknown";
  return `${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(date)} IST`;
}

export function auditLabel(value: string | null | undefined) {
  if (!value) return "Unknown";
  const labels: Record<string, string> = {
    raw_action: "Provider action", formula_action: "Formula action", formula_units: "Requested share change",
    current_units: "Held shares", score: "Formula score", formula_hash: "Formula revision", prompt_hash: "Prompt revision",
    source_hashes: "Source revisions", provider_families: "Provider/model families", holdings_snapshot: "Holdings context",
    cruxx: "Crux", fundamentals_short: "Short-term fundamentals", fundamentals_medium_long: "Medium/long-term fundamentals",
    "mean-mode-action": "Provider action score", "technical-scan-confidence": "Technical scan confidence",
    "premarket-trend": "Premarket trend", "last-5-candles-trend": "Last five candles trend",
    "fundamentals-short": "Short-term fundamentals", "fundamentals-medium-long": "Medium/long-term fundamentals",
    prospective: "Captured during the run", legacy_observed: "Legacy response observed later",
    calculation_observed: "Present calculation observed later", calculation_input: "Present calculation inputs",
  };
  return labels[value] ?? value.replaceAll("_", " ").replaceAll("-", " ").replace(/^./, character => character.toUpperCase());
}

// Render semantic summaries; never dump potentially large/private payload objects.
export function describeAuditValue(value: unknown): string {
  if (value === null || value === undefined) return "Unknown";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return formatAuditNumber(value);
  if (typeof value === "string") return /^-?\d+(\.\d+)?$/.test(value) ? formatAuditNumber(value) : value;
  if (Array.isArray(value)) return value.length ? `${value.length} recorded ${value.length === 1 ? "entry" : "entries"}` : "No recorded entries";
  return "Recorded context changed; original source review required";
}

export function describeAuditCoverage(coverage: AuditComparison["coverage"]) {
  if (typeof coverage === "string") return coverage;
  if (!coverage || typeof coverage !== "object") return "History coverage unknown.";
  const details = coverage as { queried_decisions?: number; has_more?: boolean; scope?: string };
  const count = typeof details.queried_decisions === "number" ? `${details.queried_decisions} earlier frozen observations examined. ` : "";
  return `${count}${details.has_more ? "More frozen history exists. " : ""}${details.scope ?? "Uncaptured and failed-only runs are outside frozen-history coverage."}`;
}

export function uniqueAuditFindings(comparison: AuditComparison): AuditFinding[] {
  const all = [...(comparison.current?.calculation.findings ?? []), ...(comparison.current?.sizing.findings ?? []), ...(comparison.comparison?.findings ?? [])];
  return all.filter((item, index) => all.findIndex(other => other.code === item.code && other.detail === item.detail) === index);
}

export function savedInputScore(decision: AuditDecision, id: string) {
  if (id === "mean-mode-action") return decision.calculation.raw_action ? auditNumber(decision.formula?.actionScores[decision.calculation.raw_action]) : null;
  if (id === "technical-scan-confidence") return auditNumber(decision.technical?.confidence);
  if (id === "premarket-trend") return auditNumber(decision.technical?.premarket);
  if (id === "last-5-candles-trend") return auditNumber(decision.technical?.last5);
  return auditNumber(decision.calculation.averages?.[id]);
}

export function scoreInputContribution(row: AuditScoreInput) {
  if (row.score === null) return null;
  return row.score * getScoreMatrixRowEffectiveMultiplier(row);
}
