"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { URLs } from "@/lib/urls";
import { apiService } from "@/services/api";

type CostDriver = { rank: number; driver: string; source: string; monthToDateCost: number; projectedMonthEndCost: number; usageQuantity: number; unit: string; confidence: string; severity: string; whyItCostsMoney: string; suggestedAction: string; estimatedMonthlySavings: number; linkToAWSConsole?: string | null };
type Traffic = { path: string; contentType: string; extension: string; requests: number; totalBytes: number; totalGB: number; estimatedTransferCost: number; cacheHitRate: number; topUserAgent: string; classification: string; recommendation: string };
type Recommendation = { driverKey: string; severity: string; title: string; explanation: string; suggestedAction: string; estimatedMonthlySavingsUsd: number; confidence: string };
type MetricRow = Record<string, string | number | boolean | null | undefined>;
type Dashboard = { summary: Record<string, unknown>; dailyCostTrend: MetricRow[]; dataTransferTrend: MetricRow[]; topServices: MetricRow[]; topUsageTypes: MetricRow[]; costDrivers: CostDriver[]; traffic: Traffic[]; recommendations: Recommendation[]; inventory: Record<string, unknown>; debug: Record<string, unknown> };

const money = (v: number) => `$${Number(v || 0).toFixed(2)}`;
const gb = (v: number) => `${Number(v || 0).toFixed(2)} GB`;
const severityClass = (severity: string) => severity === "critical" ? "bg-red-100 text-red-700" : severity === "high" ? "bg-orange-100 text-orange-700" : severity === "medium" ? "bg-yellow-100 text-yellow-800" : "bg-emerald-100 text-emerald-700";

function MiniBars({ rows, valueKey = "cost", labelKey = "name" }: { rows: MetricRow[]; valueKey?: string; labelKey?: string }) {
  const max = Math.max(...rows.map((r) => Number(r[valueKey] || 0)), 1);
  return <div className="space-y-2">{rows.map((row) => <div key={String(row[labelKey])} className="space-y-1"><div className="flex justify-between text-xs"><span className="truncate pr-2">{String(row[labelKey])}</span><span>{valueKey === "cost" ? money(Number(row[valueKey] || 0)) : String(row[valueKey] ?? "")}</span></div><div className="h-2 rounded bg-muted"><div className="h-2 rounded bg-primary" style={{ width: `${Math.max(4, (Number(row[valueKey] || 0) / max) * 100)}%` }} /></div></div>)}</div>;
}

export default function PlatformCostDriversPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(refresh = false) {
    setError(null);
    if (refresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    try {
      const response = refresh ? await apiService.post<Dashboard>(URLs.costDrivers.refresh()) : await apiService.get<Dashboard>(URLs.costDrivers.summary());
      setData(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load cost drivers");
    } finally {
      if (refresh) {
        setRefreshing(false);
      } else {
        setLoading(false);
      }
    }
  }
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const summaryCards = useMemo(() => data ? [
    ["Month-to-date AWS actual cost", money(data.summary.monthToDateAwsCost as number), "AWS actuals, delayed"],
    ["Projected end-of-month cost", money(data.summary.projectedMonthEndCost as number), "Run-rate estimate"],
    ["Data transfer used", gb(data.summary.dataTransferUsedGb as number), "100 GB free tier watch"],
    ["Free transfer remaining", gb(data.summary.freeTransferRemainingGb as number), "Regional free tier"],
    ["Estimated overage", gb(data.summary.estimatedOverageGb as number), "Projected"],
    ["EC2 running instances", data.summary.ec2RunningInstances as number, "CloudWatch near-real-time"],
    ["Unattached EBS", gb(data.summary.unattachedEbsGb as number), "Manual cleanup only"],
    ["Public IPv4 count", data.summary.activePublicIpv4Count as number, "$0.005/hour default"],
    ["High-risk resources", Object.values((data.summary.activeHighRiskResources as Record<string, number> | undefined) || {}).reduce((a, b) => Number(a) + Number(b), 0), "Transfer Family / NAT / ALB"],
  ] : [], [data]);

  if (loading) return <div className="text-sm text-muted-foreground">Loading Platform Cost Drivers…</div>;
  if (!data) return <div className="text-sm text-red-600">{error || "No cost driver data available."}</div>;

  return <div className="w-full max-w-none space-y-6 lg:-ml-[22%] lg:w-[120%]">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div><h3 className="text-lg font-medium">Platform Cost Drivers</h3><p className="text-sm text-muted-foreground">Read-only AWS billing actuals plus website route/asset attribution for Cred-x bandwidth, bots, media, API traffic, EC2, storage, logs, and hidden resources.</p></div>
      <Button onClick={() => load(true)} disabled={refreshing} size="sm"><RefreshCw className="mr-2 h-4 w-4" />{refreshing ? "Refreshing" : "Refresh now"}</Button>
    </div>
    <Separator />
    {error && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

    <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-5">{summaryCards.map(([label, value, hint]) => <Card key={String(label)}><CardHeader className="pb-2"><CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle></CardHeader><CardContent><div className="text-2xl font-semibold">{value}</div><p className="mt-1 text-[11px] text-muted-foreground">{hint}</p></CardContent></Card>)}</div>

    <div className="grid gap-4 xl:grid-cols-3"><Card><CardHeader><CardTitle>Daily AWS cost trend</CardTitle></CardHeader><CardContent><MiniBars rows={data.dailyCostTrend.slice(-14)} valueKey="cost" labelKey="date" /></CardContent></Card><Card><CardHeader><CardTitle>Data transfer vs 100 GB</CardTitle></CardHeader><CardContent><MiniBars rows={data.dataTransferTrend.slice(-14)} valueKey="gb" labelKey="date" /></CardContent></Card><Card><CardHeader><CardTitle>Top AWS services</CardTitle></CardHeader><CardContent><MiniBars rows={data.topServices} /></CardContent></Card></div>

    <Card><CardHeader><CardTitle>Top cost drivers</CardTitle></CardHeader><CardContent className="overflow-x-auto"><table className="w-full min-w-[1100px] text-left text-xs"><thead className="border-b text-muted-foreground"><tr>{["#","Driver","Source","MTD","Projected","Usage","Confidence","Severity","Why it costs money","Suggested action","Savings"].map(h => <th key={h} className="p-2">{h}</th>)}</tr></thead><tbody>{data.costDrivers.map(d => <tr key={d.rank} className="border-b align-top"><td className="p-2">{d.rank}</td><td className="p-2 font-medium">{d.driver}</td><td className="p-2">{d.source}</td><td className="p-2">{money(d.monthToDateCost)}</td><td className="p-2">{money(d.projectedMonthEndCost)}</td><td className="p-2">{d.usageQuantity} {d.unit}</td><td className="p-2">{d.confidence}</td><td className="p-2"><span className={`rounded px-2 py-1 ${severityClass(d.severity)}`}>{d.severity}</span></td><td className="p-2">{d.whyItCostsMoney}</td><td className="p-2">{d.suggestedAction}</td><td className="p-2">{money(d.estimatedMonthlySavings)}</td></tr>)}</tbody></table></CardContent></Card>

    <Card><CardHeader><CardTitle>Top bandwidth routes/assets: is it images, videos, API, JS, HTML, or bots?</CardTitle></CardHeader><CardContent className="overflow-x-auto"><table className="w-full min-w-[1000px] text-left text-xs"><thead className="border-b text-muted-foreground"><tr>{["Path","Type","Requests","Total GB","Transfer cost","Cache hit","Top UA","Recommendation"].map(h => <th key={h} className="p-2">{h}</th>)}</tr></thead><tbody>{data.traffic.map(t => <tr key={t.path} className="border-b align-top"><td className="max-w-[260px] truncate p-2 font-medium">{t.path}</td><td className="p-2">{t.classification}<br/><span className="text-muted-foreground">{t.contentType}</span></td><td className="p-2">{t.requests.toLocaleString()}</td><td className="p-2">{t.totalGB}</td><td className="p-2">{money(t.estimatedTransferCost)}</td><td className="p-2">{Math.round(t.cacheHitRate * 100)}%</td><td className="p-2">{t.topUserAgent}</td><td className="p-2">{t.recommendation}</td></tr>)}</tbody></table></CardContent></Card>

    <div className="grid gap-4 lg:grid-cols-2"><Card><CardHeader><CardTitle>Rule-based recommendations</CardTitle></CardHeader><CardContent className="space-y-3">{data.recommendations.map(r => <div key={r.driverKey} className="rounded-md border p-3"><div className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-orange-500"/><span className={`rounded px-2 py-0.5 text-xs ${severityClass(r.severity)}`}>{r.severity}</span><span className="font-medium">{r.title}</span></div><p className="mt-2 text-sm text-muted-foreground">{r.explanation}</p><p className="mt-1 text-sm">{r.suggestedAction}</p><p className="mt-1 text-xs text-muted-foreground">Estimated monthly savings: {money(r.estimatedMonthlySavingsUsd)} · confidence: {r.confidence}</p></div>)}</CardContent></Card><Card><CardHeader><CardTitle>Settings / debug</CardTitle></CardHeader><CardContent className="space-y-2 text-sm"><p><b>Last AWS refresh:</b> {String(data.debug.lastAwsRefreshTime as string | undefined || "not refreshed yet")}</p><p><b>Mock mode:</b> {String(data.debug.mockMode as boolean)}</p><p><b>AWS region:</b> {String(data.debug.awsRegion)}</p><p><b>Missing permissions:</b> {((data.inventory.missingPermissions as string[] | undefined) || []).join(", ") || "None reported in mock data"}</p><p><b>Cost Explorer:</b> {String(data.debug.costExplorerLabel)}</p><p><b>CloudWatch:</b> {String(data.debug.cloudWatchLabel)}</p><p><b>App logs:</b> {String(data.debug.appLogsLabel)}</p><p><b>Cache TTL:</b> {String(data.debug.cacheTtlSeconds)}s; live AWS calls are never made on every page view.</p></CardContent></Card></div>
  </div>;
}
