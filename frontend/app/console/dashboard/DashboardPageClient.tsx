"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Info, RefreshCw } from "lucide-react";
import { Dialog } from "radix-ui";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/useAuth";
import { SidebarPolicyContext } from "@/hooks/useSidebarPolicy";
import { fetchReferenceQuote } from "@/hooks/useRebalanceCostQuote";
import { validDashboardFxRate } from "@/lib/fxPresentation";
import type { BullpenPositionsResponse } from "@/lib/bullpenPositions";
import { URLs } from "@/lib/urls";
import { apiService } from "@/services/api";
import {
  formatInr,
  formatUsd,
  formatTs,
} from "./_components/dashboardOverviewUtils";
import { dataAge } from "./_components/TotalDataStatus";
import {
  balanceTotal,
  bullpenBalance,
  emptyBalance,
  indiaBalance,
  labels,
  mergeBalances,
  readBalance,
  saveBalance,
  usBalance,
  visibleSources,
  type Amount,
  type Balance,
  type Fx,
  type Source,
} from "./_components/dashboardBalances";

async function fetchBullpenPositions(
  forceFresh = false,
): Promise<BullpenPositionsResponse> {
  const params = new URLSearchParams({
    caller_source: forceFresh ? "ui-dashboard-refresh" : "ui-passive-refresh",
    max_age_seconds: forceFresh ? "0" : "20",
    request_id: crypto.randomUUID(),
  });
  params.set(forceFresh ? "force_fresh" : "passive", "true");
  const response = await fetch(`/api/bullpen-ai/positions?${params}`, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { "Cache-Control": "no-cache" },
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "Failed to load Bullpen wallet positions.");
  }

  return (await response.json()) as BullpenPositionsResponse;
}

const historyLinks = {
  zerodha: "/console/zerodha#saved-portfolio-snapshots",
  indmoney: "/console/indmoney-us#us-snapshot-panel-saved",
};

const explanations = {
  zerodha:
    "Portfolio is the saved Kite holdings market value. Cash is the available margin.",
  indmoney:
    "Portfolio is the saved holdings value. Cash is the wallet balance from the latest import that reports it.",
  bullpen:
    "Portfolio includes active and claimable positions. The wallet total includes cash once.",
};

function loadBalance(source: Source, forceFresh: boolean) {
  switch (source) {
    case "zerodha":
      return apiService.zerodhaPortfolioOverview().then(indiaBalance);
    case "indmoney":
      return apiService.indmoneyUsPortfolioOverview().then(usBalance);
    case "bullpen":
      return fetchBullpenPositions(forceFresh).then(bullpenBalance);
  }
}

type Row = {
  balance: Balance;
  status: "loading" | "saved" | "failed" | "empty";
};
type Rows = Partial<Record<Source, Row>>;

function Board({
  userId,
  sources,
  initialFx,
}: {
  userId: number;
  sources: Source[];
  initialFx: Fx | null;
}) {
  const [rows, setRows] = useState<Rows>(() =>
    Object.fromEntries(
      sources.map((source) => [
        source,
        { balance: readBalance(userId, source), status: "loading" },
      ]),
    ),
  );
  const [fx, setFx] = useState(initialFx);
  const [reference, setReference] = useState<Awaited<
    ReturnType<typeof fetchReferenceQuote>
  > | null>(null);
  const [refreshingFx, setRefreshingFx] = useState(false);
  const [showNumbers, setShowNumbers] = useState(true);
  const inFlight = useRef(new Set<Source | "fx">());
  const mounted = useRef(false);
  const needsFx = sources.some((source) => source !== "zerodha");

  const refreshRow = useCallback(
    async (source: Source, forceFresh = false) => {
      if (inFlight.current.has(source)) return;
      inFlight.current.add(source);
      setRows((current) => ({
        ...current,
        [source]: { ...current[source]!, status: "loading" },
      }));
      try {
        const incoming = await loadBalance(source, forceFresh);
        if (!mounted.current) return;
        const hasValues = Object.values(incoming).some(Boolean);
        if (hasValues) saveBalance(userId, source, incoming);
        setRows((current) => ({
          ...current,
          [source]: {
            balance: mergeBalances(current[source]!.balance, incoming),
            status: hasValues ? "saved" : "empty",
          },
        }));
      } catch {
        if (mounted.current)
          setRows((current) => ({
            ...current,
            [source]: { ...current[source]!, status: "failed" },
          }));
      } finally {
        inFlight.current.delete(source);
      }
    },
    [userId],
  );

  const refreshFx = useCallback(
    async (bootstrap?: Fx | null) => {
      if (!needsFx || inFlight.current.has("fx")) return;
      inFlight.current.add("fx");
      setRefreshingFx(true);
      try {
        let quote = bootstrap;
        if (!quote) {
          try {
            quote = await apiService.get<Fx>(URLs.dashboard.fx(), {
              cache: "no-store",
            });
          } catch {
            /* Use the last published reference if the backend is unreachable. */
          }
        }
        if (!mounted.current) return;
        if (quote?.value && quote.as_of) {
          const next = quote;
          setFx((previous) =>
            !previous?.as_of ||
            Date.parse(next.as_of!) >= Date.parse(previous.as_of)
              ? next
              : previous,
          );
        }
        if (!validDashboardFxRate(quote ?? null)) {
          const published = await fetchReferenceQuote();
          if (mounted.current) setReference(published);
        }
      } finally {
        inFlight.current.delete("fx");
        if (mounted.current) setRefreshingFx(false);
      }
    },
    [needsFx],
  );

  // The parent remounts this board when the account or its enabled source list changes.
  const initialSources = useRef(sources);
  useEffect(() => {
    mounted.current = true;
    for (const source of initialSources.current) void refreshRow(source);
    void refreshFx(initialFx);
    return () => {
      mounted.current = false;
    };
  }, [refreshRow, refreshFx, initialFx]);

  const fxRate = validDashboardFxRate(fx);
  const stale =
    fx?.value && fx.value > 0 && fx.as_of
      ? { rate: fx.value, date: fx.as_of, source: fx.source }
      : null;
  const estimate =
    stale &&
    (!reference || Date.parse(stale.date) >= Date.parse(reference.date))
      ? stale
      : reference;
  const rate = fxRate ?? estimate?.rate ?? null;
  const money = (value: number | null, currency: "INR" | "USD") => {
    if (value == null) return "—";
    const formatted = currency === "USD" ? formatUsd(value) : formatInr(value);
    return showNumbers ? formatted : formatted.replace(/\p{N}/gu, "*");
  };
  const currency = (source: Source) => (source === "zerodha" ? "INR" : "USD");
  const busy =
    refreshingFx ||
    sources.some((source) => rows[source]?.status === "loading");
  const allKnown =
    sources.length > 0 &&
    sources.every((source) => balanceTotal(rows[source]!.balance) !== null);
  const sum = (keys: Source[]) =>
    keys.reduce(
      (value, key) => value + (balanceTotal(rows[key]!.balance) ?? 0),
      0,
    );
  const domestic = sources.filter((source) => source === "zerodha");
  const foreign = sources.filter((source) => source !== "zerodha");
  const totals = [
    domestic.length ? money(sum(domestic), "INR") : null,
    foreign.length ? money(sum(foreign), "USD") : null,
  ]
    .filter(Boolean)
    .join(" + ");
  const combined =
    allKnown && (!needsFx || rate != null)
      ? sum(domestic) + sum(foreign) * (rate ?? 0)
      : null;
  const fields = (row: Row) =>
    [row.balance.portfolio, row.balance.cash, row.balance.wallet].filter(
      (a): a is Amount => !!a,
    );
  const statusText = (row: Row) => {
    const known = fields(row).length > 0;
    if (row.status === "failed")
      return known
        ? "Refresh failed · Last-known values shown"
        : "Couldn’t load saved balances";
    if (row.status === "loading")
      return known
        ? "Refreshing · Last-known values shown"
        : "Loading saved balances…";
    if (row.status === "empty")
      return known ? "Last-known values shown" : "No saved balances available";
    return "Saved snapshot available";
  };
  const capture = (at: string) => (
    <time dateTime={at} title={formatTs(at)}>
      {formatTs(at)} IST
    </time>
  );
  const breakdown = (source: Source, balance: Balance) => (
    <div className="space-y-1 text-xs text-slate-600">
      {(["portfolio", "cash"] as const).map((key) => (
        <p key={key}>
          {key === "cash" ? "Cash" : "Portfolio"} ·{" "}
          {money(balance[key]?.value ?? null, currency(source))}
          {balance[key] && <> · {capture(balance[key].at)}</>}
        </p>
      ))}
    </div>
  );
  const tableStyle =
    "w-full min-w-[560px] text-left text-sm [&_th]:px-4 [&_th]:py-2 [&_td]:px-4 [&_td]:py-3 [&_td]:align-top";

  return (
    <section
      className="rounded-3xl border border-indigo-100 bg-indigo-50/70 p-4 text-slate-950 shadow-sm sm:p-5"
      data-performance-usable="dashboard-summary"
    >
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <p className="mb-4 mt-1 text-sm text-slate-600">
        Portfolio overview · Saved snapshots
      </p>
      <Tabs defaultValue="overview" className="gap-3">
        <TabsList
          aria-label="Portfolio overview details"
          className="flex h-auto w-fit max-w-full flex-wrap justify-start gap-1 bg-transparent p-0"
        >
          {[
            ["overview", "Overview"],
            ["sources", "Sources and freshness"],
            ["refresh", "Refresh behaviour"],
          ].map(([id, label]) => (
            <TabsTrigger
              key={id}
              value={id}
              className="rounded-lg bg-indigo-100 px-3 py-2 text-xs normal-case tracking-normal text-slate-700 data-active:bg-violet-700 data-active:text-white"
            >
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        {needsFx && (
          <p
            className="rounded-xl border border-indigo-100 bg-white px-4 py-2 text-xs"
            data-fx-status={
              fxRate ? "valid" : estimate ? "reference" : "unavailable"
            }
          >
            {fxRate && fx
              ? `USD/INR ${fxRate.toFixed(4)} · ${fx.source} · ${formatTs(fx.as_of)} IST`
              : estimate
                ? `Reference USD/INR ${estimate.rate.toFixed(4)} · ${estimate.source} · ${estimate.date.slice(0, 10)}. Combined INR is an estimate.`
                : "USD/INR unavailable · USD balances shown in dollars"}
          </p>
        )}
        <div className="flex items-center gap-3">
          <Button
            type="button"
            disabled={busy || !sources.length}
            onClick={() => {
              for (const source of sources) void refreshRow(source, true);
              void refreshFx();
            }}
            className="bg-amber-400 text-slate-950 hover:bg-amber-300"
          >
            <RefreshCw className={busy ? "size-4 animate-spin" : "size-4"} />{" "}
            Refresh Board
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={
              showNumbers
                ? "Hide investment numbers"
                : "Show investment numbers"
            }
            aria-pressed={showNumbers}
            onClick={() => setShowNumbers(!showNumbers)}
          >
            {showNumbers ? <EyeOff /> : <Eye />}
          </Button>
        </div>
        {(["overview", "sources"] as const).map((view) => (
          <TabsContent key={view} value={view} className="mt-0">
            <div
              className="overflow-x-auto rounded-xl border border-indigo-100 bg-white"
              role="region"
              aria-label={
                view === "sources"
                  ? "Sources and freshness table"
                  : "Portfolio overview table"
              }
              tabIndex={0}
            >
              <table className={tableStyle}>
                <thead className="bg-slate-50 text-xs text-slate-600">
                  <tr>
                    {(view === "sources"
                      ? [
                          "Source",
                          "Source status",
                          "Captured snapshot",
                          "Snapshot age",
                        ]
                      : ["Portfolio", "Portfolio + cash", "Snapshot age"]
                    ).map((h) => (
                      <th key={h} scope="col">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {sources.map((source) => {
                    const row = rows[source]!;
                    const total = balanceTotal(row.balance);
                    const times = fields(row).map((a) => Date.parse(a.at));
                    const latest = times.length ? Math.max(...times) : null;
                    const mixed =
                      times.length > 1 && Math.min(...times) !== latest;
                    return (
                      <tr key={source}>
                        <th scope="row">
                          <div className="flex items-center gap-2">
                            {source === "zerodha" && view === "overview"
                              ? "India"
                              : labels[source]}
                            <Dialog.Root>
                              <Dialog.Trigger asChild>
                                <button
                                  type="button"
                                  className="rounded p-1"
                                  aria-label={`${labels[source]} balance details`}
                                >
                                  <Info className="size-4" />
                                </button>
                              </Dialog.Trigger>
                              <Dialog.Portal>
                                <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/50" />
                                <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 text-slate-950 shadow-xl">
                                  <Dialog.Title className="font-semibold">
                                    {labels[source]} balance details
                                  </Dialog.Title>
                                  <Dialog.Description className="my-3 text-sm">
                                    {explanations[source]}
                                  </Dialog.Description>
                                  <Dialog.Close asChild>
                                    <Button variant="outline">Close</Button>
                                  </Dialog.Close>
                                </Dialog.Content>
                              </Dialog.Portal>
                            </Dialog.Root>
                            <button
                              type="button"
                              aria-label={`Refresh ${labels[source]}`}
                              disabled={row.status === "loading"}
                              onClick={() => void refreshRow(source, true)}
                              className="rounded p-1 text-slate-600"
                            >
                              <RefreshCw
                                className={
                                  row.status === "loading"
                                    ? "size-4 animate-spin"
                                    : "size-4"
                                }
                              />
                            </button>
                          </div>
                          {source !== "bullpen" && (
                            <a
                              className="text-xs font-normal text-slate-600 underline"
                              href={historyLinks[source]}
                            >
                              Saved history
                            </a>
                          )}
                        </th>
                        {view === "sources" && (
                          <td>
                            <p role="status">{statusText(row)}</p>
                          </td>
                        )}
                        <td>
                          {view === "overview" ? (
                            <>
                              <p className="font-semibold">
                                {total === null
                                  ? "Total unavailable"
                                  : money(total, currency(source))}
                              </p>
                              {source !== "zerodha" &&
                              fxRate &&
                              total != null ? (
                                <p className="text-xs">
                                  {money(total * fxRate, "INR")}
                                </p>
                              ) : null}
                              {breakdown(source, row.balance)}
                              <p
                                className="mt-1 text-xs text-slate-600"
                                role="status"
                              >
                                {statusText(row)}
                              </p>
                            </>
                          ) : (
                            breakdown(source, row.balance)
                          )}
                        </td>
                        <td className="text-xs text-slate-600">
                          {latest != null ? (
                            <>
                              {dataAge(latest)}
                              <br />
                              {capture(new Date(latest).toISOString())}
                            </>
                          ) : (
                            "—"
                          )}
                          {mixed && (
                            <p>Components have different capture times.</p>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </TabsContent>
        ))}
        <TabsContent
          value="refresh"
          className="rounded-xl border border-indigo-100 bg-white p-4 text-sm"
        >
          Refresh Board reloads the latest saved balances for the displayed
          portfolios.{needsFx && " It also checks the USD/INR rate."}
          {sources.includes("bullpen") &&
            " Bullpen requests a fresh wallet read."}{" "}
          Each amount shows its capture time.
        </TabsContent>
      </Tabs>
      {!sources.length && (
        <p className="mt-3 text-sm">
          No portfolio sources are enabled for this account.
        </p>
      )}
      {sources.length > 0 && (
        <div className="mt-3 border-t border-indigo-200 pt-3">
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="text-sm font-semibold text-slate-600">
              Total Investments
            </span>
            <strong>
              {combined != null
                ? money(combined, "INR")
                : allKnown
                  ? totals
                  : "Incomplete total"}
            </strong>
            {combined !== null && needsFx && !fxRate && (
              <span className="text-xs">Estimated INR</span>
            )}
          </div>
          <p className="mt-1 text-xs text-slate-600">
            {sources.map((s) => labels[s]).join(" + ")}
            {allKnown && foreign.length > 0 ? ` · ${totals}` : ""}
          </p>
          <details className="mt-2 text-xs text-slate-600">
            <summary className="cursor-pointer underline">
              How portfolio totals are calculated
            </summary>
            <p className="mt-2">
              Each total uses the latest saved portfolio and cash amounts. The
              combined total includes the enabled sources shown above. Each
              component keeps its original capture time.
            </p>
          </details>
        </div>
      )}
    </section>
  );
}

export function DashboardPageClient({
  initialFx = null,
}: {
  initialFx?: Fx | null;
}) {
  const { user } = useAuth();
  const policy = useContext(SidebarPolicyContext);
  if (!policy || !user)
    return (
      <div role="status">
        {policy === null
          ? "Portfolio visibility settings are unavailable."
          : "Loading dashboard…"}
      </div>
    );
  const sources = visibleSources(policy, user.role);
  return (
    <Board
      key={`${user.id}:${sources.join(",")}`}
      userId={user.id}
      sources={sources}
      initialFx={initialFx}
    />
  );
}
