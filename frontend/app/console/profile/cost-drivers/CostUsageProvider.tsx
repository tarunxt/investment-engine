"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { URLs } from "@/lib/urls";
import { apiService } from "@/services/api";
import { OptimizationActionCenter } from "./OptimizationActionCenter";
import type { Dashboard } from "./types";

type UsageContext = {
  data: Dashboard;
  selectedMonth: string;
  setSelectedMonth: (month: string) => void;
  refreshing: boolean;
  lastLoadedAt: Date | null;
  load: (refresh?: boolean) => Promise<void>;
};
const Context = createContext<UsageContext | null>(null);

export function useCostUsage() {
  const value = useContext(Context);
  if (!value) throw new Error("Cost usage must be inside its provider");
  return value;
}

export function CostUsageProvider({ children }: { children: ReactNode }) {
  const [selectedMonth, selectMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const setSelectedMonth = useCallback((month: string) => {
    generation.current += 1;
    pending.current = false;
    setData(null);
    setLoading(true);
    setFailed(false);
    selectMonth(month);
  }, []);
  const load = useCallback(async (refresh = false) => {
    if (pending.current) return;
    pending.current = true;
    const request = ++generation.current;
    setLoading(true);
    setFailed(false);
    try {
      const result = refresh
        ? await apiService.post<Dashboard>(URLs.costDrivers.refresh(selectedMonth))
        : await apiService.get<Dashboard>(URLs.costDrivers.summary(selectedMonth));
      if (request !== generation.current) return;
      setData(result);
      setLastLoadedAt(new Date());
    } catch {
      if (request !== generation.current) return;
      setFailed(true);
    } finally {
      if (request === generation.current) {
        pending.current = false;
        setLoading(false);
      }
    }
  }, [selectedMonth]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      generation.current += 1;
      pending.current = false;
    };
  }, [load]);

  if (loading && !data) return <p role="status" className="p-6 text-sm text-muted-foreground">Reading stored usage snapshot; no AWS collection requested…</p>;
  if (!data) return (
    <section aria-labelledby="usage-unavailable" className="max-w-3xl space-y-4 rounded-lg border p-6">
      <div role="alert">
        <h2 id="usage-unavailable" className="text-lg font-semibold">Usage and costs unavailable</h2>
        <p className="mt-2 text-sm text-muted-foreground">We couldn’t read the stored snapshot for this month. Costs are unknown. Passive reads do not request AWS collection.</p>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Button onClick={() => void load()}>Retry usage</Button>
        <Link className="text-sm underline underline-offset-4" href={URLs.routes.console.apis()}>API cost details</Link>
      </div>
    </section>
  );
  return (
    <Context.Provider value={{ data, selectedMonth, setSelectedMonth, refreshing: loading, load, lastLoadedAt }}>
      <div className="space-y-6">
        {loading && <p role="status">{data.debug.collectionOccurred === true ? "Request pending; prior snapshot shown below." : "Reading snapshot; prior provenance shown below."}</p>}
        {failed && <p role="alert">Request failed. Prior snapshot and source time remain below; successful collection is not confirmed.</p>}
        <CostSnapshotProvenance debug={data.debug} />
        {typeof data.summary.monthToDateAwsCost === "number" ? <OptimizationActionCenter /> : <p className="text-sm text-muted-foreground">Cost totals are unknown for this month.</p>}{children}</div>
    </Context.Provider>
  );
}


function CostSnapshotProvenance({ debug }: { debug: Record<string, unknown> }) {
  const billing = debug.billingProvenance as Record<string, unknown> | null | undefined;
  const period = billing?.requestedPeriod as Record<string, unknown> | undefined;
  const meter = billing?.meter as Record<string, unknown> | undefined;
  const storage = debug.storageExposure as Record<string, unknown> | undefined;
  return <section aria-label="Snapshot provenance" className="rounded-lg border p-4 text-sm space-y-2">
    <p>Snapshot: {debug.servedStaleData ? "stale" : String(debug.snapshotState ?? "legacy; coverage unknown")}. Collection on this request: {debug.collectionOccurred === true ? "attempted" : "none"}.</p>
    <p>Source collected: {String(billing?.collectedAt ?? debug.lastAwsRefreshTime ?? "unknown")}. Source age: {debug.sourceAgeSeconds == null ? "unknown" : `${String(debug.sourceAgeSeconds)} seconds`}. Usage data cutoff: {String(billing?.dataCutoff ?? "unknown")}.</p>
    <p>Account aggregate coverage: {billing ? billing.complete === true ? "complete" : "partial" : "unknown"}; provider estimate state: {String(billing?.estimateState ?? "unknown")}; currency: {String(billing?.currency ?? "unknown")}.</p>
    {period && <p>Requested period: {String(period.startInclusive)} (inclusive) to {String(period.endExclusive)} (exclusive). Requests: {String(meter?.requests ?? "unknown")}.</p>}
    <p>Account aggregates do not establish resource invoices. Viewing a snapshot does not refresh its source time.</p>
    {storage && <>
      <p>Storage tariff state: {String(storage.state)}. Gross recurring exposure: {storage.grossMonthlyExposureUsd == null ? "unknown" : `$${String(storage.grossMonthlyExposureUsd)}/month`}. Owner-approved removable savings: unknown. Actual bill: unknown.</p>
      <p>Tariff version: {String(storage.tariffVersion)}; source: {String(storage.source)}. {String(storage.exclusions)}</p>
    </>}
  </section>;
}
