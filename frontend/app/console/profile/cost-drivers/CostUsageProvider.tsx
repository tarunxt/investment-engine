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
      setData(null);
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

  if (loading) return <p role="status" className="p-6 text-sm text-muted-foreground">Loading usage and costs…</p>;
  if (failed || !data) return (
    <section aria-labelledby="usage-unavailable" className="max-w-3xl space-y-4 rounded-lg border p-6">
      <div role="alert">
        <h2 id="usage-unavailable" className="text-lg font-semibold">Usage and costs unavailable</h2>
        <p className="mt-2 text-sm text-muted-foreground">We couldn’t load usage for this month. Costs are unknown until usage loads successfully.</p>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Button onClick={() => void load()}>Retry usage</Button>
        <Link className="text-sm underline underline-offset-4" href={URLs.routes.console.apis()}>API cost details</Link>
      </div>
    </section>
  );
  return (
    <Context.Provider value={{ data, selectedMonth, setSelectedMonth, refreshing: loading, load, lastLoadedAt }}>
      <div className="space-y-6">{typeof data.summary.monthToDateAwsCost === "number" ? <OptimizationActionCenter /> : <p className="text-sm text-muted-foreground">Cost totals are unknown for this month.</p>}{children}</div>
    </Context.Provider>
  );
}
