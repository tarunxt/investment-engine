"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { URLs } from "@/lib/urls";
import { apiService } from "@/services/api";

type CostDriver = {
  rank: number;
  driver: string;
  source: string;
  monthToDateCost: number;
  projectedMonthEndCost: number;
  usageQuantity: number;
  unit: string;
  confidence: string;
  severity: string;
  whyItCostsMoney: string;
  suggestedAction: string;
  estimatedMonthlySavings: number;
  estimatedMonthlySavingsDisplay?: string | null;
  linkToAWSConsole?: string | null;
};
type Traffic = {
  path: string;
  contentType: string;
  extension: string;
  requests: number;
  totalBytes: number;
  totalGB: number;
  estimatedTransferCost: number;
  cacheHitRate: number;
  topUserAgent: string;
  classification: string;
  recommendation: string;
};
type EvidenceItem = {
  label: string;
  value: string | number;
  unit?: string | null;
};
type Recommendation = {
  id?: string | null;
  driverKey: string;
  severity: string;
  title: string;
  explanation?: string;
  whyThisMatters?: string | null;
  suggestedAction?: string;
  recommendedActions?: string[];
  estimatedMonthlySavingsUsd?: number | null;
  confidence: string;
  source: string;
  evidence?: EvidenceItem[];
  lastCheckedAt?: string | null;
  relatedAwsConsoleUrl?: string | null;
};
type TransferBreakdown = {
  classification: string;
  totalBytes: number;
  totalGB: number;
  requests: number;
  topPaths?: string[];
};
type MetricRow = Record<
  string,
  string | number | boolean | TransferBreakdown[] | null | undefined
>;
type Diagnostic = { service: string; status: string; message: string };
type Dashboard = {
  summary: Record<string, unknown>;
  dailyCostTrend: MetricRow[];
  dataTransferTrend: MetricRow[];
  topServices: MetricRow[];
  topUsageTypes: MetricRow[];
  costDrivers: CostDriver[];
  traffic: Traffic[];
  recommendations: Recommendation[];
  inventory: Record<string, unknown>;
  debug: Record<string, unknown>;
  diagnostics?: Diagnostic[];
};

const money = (v: number) => `$${Number(v || 0).toFixed(2)}`;
const savings = (v?: number | null) =>
  v == null ? "Not enough data" : money(v);
const gb = (v: number) => `${Number(v || 0).toFixed(2)} GB`;
const severityClass = (severity: string) =>
  severity === "critical"
    ? "bg-red-100 text-red-700"
    : severity === "high"
      ? "bg-orange-100 text-orange-700"
      : severity === "medium"
        ? "bg-yellow-100 text-yellow-800"
        : severity === "info"
          ? "bg-sky-100 text-sky-700"
          : "bg-emerald-100 text-emerald-700";
const confidenceClass = (confidence: string) =>
  confidence === "confirmed"
    ? "bg-emerald-100 text-emerald-700"
    : confidence === "demo"
      ? "bg-purple-100 text-purple-700"
      : confidence === "not_checked"
        ? "bg-slate-100 text-slate-700"
        : "bg-blue-100 text-blue-700";

const monthValue = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
const monthLabel = (value: string) => {
  const [year, month] = value.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
};
const monthOptions = () => {
  const current = new Date();
  return Array.from({ length: 13 }, (_, index) => {
    const optionDate = new Date(
      current.getFullYear(),
      current.getMonth() - index,
      1,
    );
    const value = monthValue(optionDate);
    return { value, label: monthLabel(value) };
  });
};

function RecommendationCard({
  recommendation,
}: {
  recommendation: Recommendation;
}) {
  const actions = recommendation.recommendedActions?.length
    ? recommendation.recommendedActions
    : recommendation.suggestedAction
      ? [recommendation.suggestedAction]
      : [];
  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-orange-500" />
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${severityClass(recommendation.severity)}`}
        >
          {recommendation.severity}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${confidenceClass(recommendation.confidence)}`}
        >
          {recommendation.confidence}
        </span>
        {recommendation.source === "mock" && (
          <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700">
            demo
          </span>
        )}
        <h4 className="min-w-[240px] flex-1 text-sm font-semibold">
          {recommendation.title}
        </h4>
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <section>
          <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Why this matters
          </h5>
          <p className="mt-1 text-sm text-muted-foreground">
            {recommendation.whyThisMatters || recommendation.explanation}
          </p>
        </section>
        <section>
          <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Evidence
          </h5>
          <dl className="mt-1 space-y-1 text-sm">
            {(recommendation.evidence || []).map((e) => (
              <div key={e.label} className="flex gap-2">
                <dt className="min-w-32 text-muted-foreground">{e.label}:</dt>
                <dd className="font-medium">
                  {String(e.value)}
                  {e.unit ? ` ${e.unit}` : ""}
                </dd>
              </div>
            ))}
            <div className="flex gap-2">
              <dt className="min-w-32 text-muted-foreground">Source:</dt>
              <dd className="font-medium">{recommendation.source}</dd>
            </div>
            {recommendation.lastCheckedAt && (
              <div className="flex gap-2">
                <dt className="min-w-32 text-muted-foreground">
                  Last checked:
                </dt>
                <dd className="font-medium">
                  {new Date(recommendation.lastCheckedAt).toLocaleString()}
                </dd>
              </div>
            )}
          </dl>
        </section>
        <section>
          <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Recommended action
          </h5>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
            {actions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        </section>
        <section>
          <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Estimated savings
          </h5>
          <p className="mt-1 text-sm font-medium">
            Estimated monthly savings:{" "}
            {savings(recommendation.estimatedMonthlySavingsUsd)}
          </p>
        </section>
      </div>
    </div>
  );
}

function MiniBars({
  rows,
  valueKey = "cost",
  labelKey = "name",
  onRowClick,
}: {
  rows: MetricRow[];
  valueKey?: string;
  labelKey?: string;
  onRowClick?: (row: MetricRow) => void;
}) {
  const max = Math.max(...rows.map((r) => Number(r[valueKey] || 0)), 1);
  return (
    <div className="space-y-2">
      {rows.map((row) => {
        const clickable = Boolean(onRowClick);
        const content = (
          <>
            <div className="flex justify-between text-xs">
              <span className="truncate pr-2">{String(row[labelKey])}</span>
              <span>
                {valueKey === "cost"
                  ? money(Number(row[valueKey] || 0))
                  : String(row[valueKey] ?? "")}
              </span>
            </div>
            <div className="h-2 rounded bg-muted">
              <div
                className="h-2 rounded bg-primary"
                style={{
                  width: `${Math.max(4, (Number(row[valueKey] || 0) / max) * 100)}%`,
                }}
              />
            </div>
          </>
        );
        return clickable ? (
          <button
            key={String(row[labelKey])}
            type="button"
            onClick={() => onRowClick?.(row)}
            className="block w-full space-y-1 rounded text-left transition hover:bg-muted/60 focus:outline-none focus:ring-2 focus:ring-ring"
            aria-label={`Open data transfer details for ${String(row[labelKey])}`}
          >
            {content}
          </button>
        ) : (
          <div key={String(row[labelKey])} className="space-y-1">
            {content}
          </div>
        );
      })}
    </div>
  );
}

function TransferBreakdownDialog({
  row,
  onClose,
}: {
  row: MetricRow | null;
  onClose: () => void;
}) {
  if (!row) return null;
  const breakdown = Array.isArray(row.breakdown)
    ? (row.breakdown as TransferBreakdown[])
    : [];
  const totalGb = breakdown.reduce(
    (sum, item) => sum + Number(item.totalGB || 0),
    0,
  );
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="transfer-breakdown-title"
    >
      <div className="w-full max-w-2xl rounded-lg border bg-background shadow-lg">
        <div className="flex items-start justify-between gap-4 border-b p-4">
          <div>
            <h3
              id="transfer-breakdown-title"
              className="text-base font-semibold"
            >
              Data transferred on {String(row.date)}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Daily total: {gb(Number(row.dailyGB || totalGb || 0))};
              month-to-date meter: {gb(Number(row.gb || 0))}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close data transfer details"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4">
          {breakdown.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="p-2">Type</th>
                    <th className="p-2">Quantity</th>
                    <th className="p-2">Requests</th>
                    <th className="p-2">Representative paths</th>
                  </tr>
                </thead>
                <tbody>
                  {breakdown.map((item) => (
                    <tr
                      key={item.classification}
                      className="border-b align-top"
                    >
                      <td className="p-2 font-medium">{item.classification}</td>
                      <td className="p-2">{gb(item.totalGB)}</td>
                      <td className="p-2">
                        {Number(item.requests || 0).toLocaleString()}
                      </td>
                      <td className="p-2 text-muted-foreground">
                        {item.topPaths?.length
                          ? item.topPaths.join(", ")
                          : "No path sample"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No route-level app traffic breakup is available for this day yet.
              The meter still shows AWS Cost Explorer transfer totals where
              available.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function PlatformCostDriversPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const months = useMemo(() => monthOptions(), []);
  const [selectedMonth, setSelectedMonth] = useState(() =>
    monthValue(new Date()),
  );
  const [selectedTransferDay, setSelectedTransferDay] =
    useState<MetricRow | null>(null);

  const load = useCallback(
    async (refresh = false) => {
      setError(null);
      if (refresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      try {
        const response = refresh
          ? await apiService.post<Dashboard>(
              URLs.costDrivers.refresh(selectedMonth),
            )
          : await apiService.get<Dashboard>(
              URLs.costDrivers.summary(selectedMonth),
            );
        setData(response);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Unable to load cost drivers",
        );
      } finally {
        if (refresh) {
          setRefreshing(false);
        } else {
          setLoading(false);
        }
      }
    },
    [selectedMonth],
  );
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const selectedMonthLabel = monthLabel(selectedMonth);

  const summaryCards = useMemo(
    () =>
      data
        ? [
            [
              "Selected month AWS actual cost",
              money(data.summary.monthToDateAwsCost as number),
              "AWS actuals, delayed",
            ],
            [
              "Projected end-of-month cost",
              money(data.summary.projectedMonthEndCost as number),
              "Run-rate estimate",
            ],
            [
              "Data transfer used",
              gb(data.summary.dataTransferUsedGb as number),
              "100 GB free tier watch",
            ],
            [
              "Free transfer remaining",
              gb(data.summary.freeTransferRemainingGb as number),
              "Regional free tier",
            ],
            [
              "Estimated overage",
              gb(data.summary.estimatedOverageGb as number),
              "Projected",
            ],
            [
              "Projected overage cost",
              money((data.summary.projectedOverageUsd as number) || 0),
              "Internet transfer out only",
            ],
            [
              "EC2 running instances",
              data.summary.ec2RunningInstances as number,
              "CloudWatch near-real-time",
            ],
            [
              "Unattached EBS",
              gb(data.summary.unattachedEbsGb as number),
              "Manual cleanup only",
            ],
            [
              "Public IPv4 count",
              data.summary.activePublicIpv4Count as number,
              "$0.005/hour default",
            ],
            [
              "High-risk resources",
              Object.values(
                (data.summary.activeHighRiskResources as
                  | Record<string, number>
                  | undefined) || {},
              ).reduce((a, b) => Number(a) + Number(b), 0),
              "Transfer Family / NAT / ALB",
            ],
          ]
        : [],
    [data],
  );

  if (loading)
    return (
      <div className="text-sm text-muted-foreground">
        Loading Platform Cost Drivers…
      </div>
    );
  if (!data)
    return (
      <div className="text-sm text-red-600">
        {error || "No cost driver data available."}
      </div>
    );

  return (
    <div className="w-full max-w-7xl space-y-6">
      <TransferBreakdownDialog
        row={selectedTransferDay}
        onClose={() => setSelectedTransferDay(null)}
      />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-lg font-medium">Platform Cost Drivers</h3>
          <p className="text-sm text-muted-foreground">
            Read-only AWS billing actuals plus website route/asset attribution
            for Cred-x bandwidth, bots, media, API traffic, EC2, storage, logs,
            and hidden resources.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Showing all cost details for {selectedMonthLabel}.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label
            className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            htmlFor="cost-driver-month"
          >
            Month
          </label>
          <select
            id="cost-driver-month"
            value={selectedMonth}
            onChange={(event) => setSelectedMonth(event.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {months.map((month) => (
              <option key={month.value} value={month.value}>
                {month.label}
              </option>
            ))}
          </select>
          <Button onClick={() => load(true)} disabled={refreshing} size="sm">
            <RefreshCw className="mr-2 h-4 w-4" />
            {refreshing ? "Refreshing" : "Refresh now"}
          </Button>
        </div>
      </div>
      <Separator />
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {data.debug.mockMode === true && (
        <div className="rounded-md border border-purple-200 bg-purple-50 p-3 text-sm font-medium text-purple-800">
          Demo data — not real AWS account findings. Placeholder media/image
          routes are intentionally excluded so nonexistent assets are not shown
          as cost drivers.
        </div>
      )}
      {data.debug.mockMode !== true && data.costDrivers.length === 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <b>Live AWS data was not returned.</b> Open diagnostics below to see
          whether AWS credentials, IAM permissions, Cost Explorer, or stored
          traffic rollups are missing.
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {summaryCards.map(([label, value, hint]) => (
          <Card key={String(label)} size="sm">
            <CardHeader className="pb-0">
              <CardTitle className="font-sans text-xs font-semibold normal-case tracking-normal text-muted-foreground">
                {label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold tracking-tight">
                {value}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card size="sm">
          <CardHeader>
            <CardTitle className="font-sans text-base normal-case tracking-normal">
              Daily AWS cost trend
            </CardTitle>
          </CardHeader>
          <CardContent>
            <MiniBars
              rows={data.dailyCostTrend.slice(-14)}
              valueKey="cost"
              labelKey="date"
            />
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle className="font-sans text-base normal-case tracking-normal">
              Data transfer vs 100 GB
            </CardTitle>
          </CardHeader>
          <CardContent>
            <MiniBars
              rows={data.dataTransferTrend.slice(-14)}
              valueKey="gb"
              labelKey="date"
              onRowClick={setSelectedTransferDay}
            />
            <p className="mt-3 text-xs text-muted-foreground">
              Click any date for data type and quantity details.
            </p>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle className="font-sans text-base normal-case tracking-normal">
              Top AWS services
            </CardTitle>
          </CardHeader>
          <CardContent>
            <MiniBars rows={data.topServices} />
          </CardContent>
        </Card>
      </div>

      <Card size="sm">
        <CardHeader>
          <CardTitle className="font-sans text-base normal-case tracking-normal">
            Top cost drivers
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-left text-xs">
            <thead className="border-b text-muted-foreground">
              <tr>
                {[
                  "#",
                  "Driver",
                  "Source",
                  "MTD",
                  "Projected",
                  "Usage",
                  "Confidence",
                  "Severity",
                  "Why it costs money",
                  "Suggested action",
                  "Savings",
                ].map((h) => (
                  <th key={h} className="p-2">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.costDrivers.length ? (
                data.costDrivers.map((d) => (
                  <tr key={d.rank} className="border-b align-top">
                    <td className="p-2">{d.rank}</td>
                    <td className="p-2 font-medium">{d.driver}</td>
                    <td className="p-2">{d.source}</td>
                    <td className="p-2">{money(d.monthToDateCost)}</td>
                    <td className="p-2">{money(d.projectedMonthEndCost)}</td>
                    <td className="p-2">
                      {d.usageQuantity} {d.unit}
                    </td>
                    <td className="p-2">{d.confidence}</td>
                    <td className="p-2">
                      <span
                        className={`rounded px-2 py-1 ${severityClass(d.severity)}`}
                      >
                        {d.severity}
                      </span>
                    </td>
                    <td className="p-2">{d.whyItCostsMoney}</td>
                    <td className="p-2">{d.suggestedAction}</td>
                    <td className="p-2">
                      {d.estimatedMonthlySavingsDisplay ||
                        money(d.estimatedMonthlySavings)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td
                    colSpan={11}
                    className="p-4 text-center text-sm text-muted-foreground"
                  >
                    No AWS Cost Explorer service spend is available from the
                    latest live check. Review diagnostics and AWS IAM/Cost
                    Explorer setup.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle className="font-sans text-base normal-case tracking-normal">
            Top bandwidth routes/assets: is it images, videos, API, JS, HTML, or
            bots?
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[1000px] text-left text-xs">
            <thead className="border-b text-muted-foreground">
              <tr>
                {[
                  "Path",
                  "Type",
                  "Requests",
                  "Total GB",
                  "Transfer cost",
                  "Cache hit",
                  "Top UA",
                  "Recommendation",
                ].map((h) => (
                  <th key={h} className="p-2">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.traffic.length ? (
                data.traffic.map((t) => (
                  <tr key={t.path} className="border-b align-top">
                    <td className="max-w-[260px] truncate p-2 font-medium">
                      {t.path}
                    </td>
                    <td className="p-2">
                      {t.classification}
                      <br />
                      <span className="text-muted-foreground">
                        {t.contentType}
                      </span>
                    </td>
                    <td className="p-2">{t.requests.toLocaleString()}</td>
                    <td className="p-2">{t.totalGB}</td>
                    <td className="p-2">{money(t.estimatedTransferCost)}</td>
                    <td className="p-2">{Math.round(t.cacheHitRate * 100)}%</td>
                    <td className="p-2">{t.topUserAgent}</td>
                    <td className="p-2">{t.recommendation}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td
                    colSpan={8}
                    className="p-4 text-center text-sm text-muted-foreground"
                  >
                    No app traffic attribution is available from the latest live
                    checks.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <Card size="sm">
          <CardHeader>
            <CardTitle className="font-sans text-base normal-case tracking-normal">
              Rule-based recommendations
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {data.recommendations.length ? (
              data.recommendations.map((r) => (
                <RecommendationCard
                  key={r.id || r.driverKey}
                  recommendation={r}
                />
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                No confirmed or estimated cost-saving recommendations are
                available from the latest checks.
              </p>
            )}
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 font-sans text-base normal-case tracking-normal">
              Checks and permissions <ChevronDown className="h-4 w-4" />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <details>
              <summary className="cursor-pointer font-medium">
                Show diagnostics
              </summary>
              <div className="mt-3 space-y-2">
                <p>
                  <b>Cost Explorer:</b> {String(data.debug.costExplorerLabel)}
                </p>
                <p>
                  <b>EC2:</b> {String(data.summary.ec2RunningInstances ?? 0)}{" "}
                  running instances reported
                </p>
                <p>
                  <b>EBS:</b> {String(data.summary.unattachedEbsGb ?? 0)} GB
                  unattached reported
                </p>
                <p>
                  <b>CloudWatch Logs:</b> {String(data.debug.cloudWatchLabel)}
                </p>
                <p>
                  <b>Transfer Family:</b>{" "}
                  {(
                    (data.inventory.missingPermissions as
                      | string[]
                      | undefined) || []
                  ).includes("transfer:ListServers")
                    ? "missing permission transfer:ListServers"
                    : "checked / unavailable in demo"}
                </p>
                <p>
                  <b>App traffic logs:</b> {String(data.debug.appLogsLabel)}
                </p>
                <p>
                  <b>Missing permissions:</b>{" "}
                  {(
                    (data.inventory.missingPermissions as
                      | string[]
                      | undefined) || []
                  ).join(", ") || "None reported"}
                </p>
                <p>
                  <b>Last refresh time:</b>{" "}
                  {String(
                    (data.debug.lastAwsRefreshTime as string | undefined) ||
                      "not refreshed yet",
                  )}
                </p>
                <p>
                  <b>AWS region:</b> {String(data.debug.awsRegion)}
                </p>
                <p>
                  <b>Cache TTL:</b> {String(data.debug.cacheTtlSeconds)}s; live
                  AWS calls are never made on every page view.
                </p>
                {(
                  data.diagnostics ||
                  (data.debug.diagnostics as Diagnostic[] | undefined) ||
                  []
                ).map((d) => (
                  <p key={`${d.service}-${d.status}`}>
                    <b>{d.service}:</b> {d.status} — {d.message}
                  </p>
                ))}
              </div>
            </details>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
