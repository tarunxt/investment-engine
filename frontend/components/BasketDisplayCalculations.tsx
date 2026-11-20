"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AllocationScoreContext } from "./AllocationScoreContext";
import { BasketMetricPopup } from "./BasketMetricPopup";
import { BasketActionSizingPopup } from "./BasketActionSizingPopup";
import { basketActionSizing } from "@/lib/basketActionSizing";
import type { UsVendorDisplayQuote } from "@/types/api";
import { apiService } from "@/services/api";
import { ALLOCATION_SCORE_POLICY, allocationScoreContract, allocationDisclosure, indmoneyActionSizing, allocateIndiaEquities, allocateDisplayScores, sellHoldingDisplay, weightComparison, displaySizingPrice, formatBasketIntegerCurrency, formatBasketDisplayCurrency, brokerDisplayAllocation, defaultDisplayParameters, historicalMean, scoreSourceIssues, stockIdentity, type BasketScoreHistory, type CurrentScoreCalculation } from "@/lib/basketDisplayCalculations";

function historyCoverage(rows: readonly { source_run_ids?: unknown; covered_at: string }[], timezone: string) {
  const current = rows.filter(row => Array.isArray(row.source_run_ids)).length;
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
  const dates = new Set(rows.map(row => format.format(new Date(row.covered_at))));
  const coverage = current === 1 && rows.length === 1 ? "Current run only" : `${current} current + ${rows.length - current} prior`;
  return `${coverage} · ${rows.length} run(s) · ${dates.size} distinct date(s) · equal weight per eligible run`;
}

type Stock = { savedComparison?: {score: number; divisor?: number; currentDivisor: number}; modelUnits?: number | null; isin?: string | null; verifiedUsIdentity?: {securityId:string;exchangeAliases:readonly string[]}; identityIssue?: string | null; investedValue?: number | null; vendorReady?: boolean; vendorLtp?: number | null; vendorAsOf?: string; vendorSource?: string; holdingQuantity?: number | null; holdingAsOf?: string; holdingSource?: string; upstoxLtp?: number | null; upstoxAsOf?: string; upstoxSource?: string; currentValue?: number | null; symbol: string; exchange: string; score: number | null; action?: string | null; ltp: number | null; limitPrice?: number | null; ltpAsOf?: string; ltpSource?: string; quoteLoading?: boolean; scoreSources?: CurrentScoreCalculation['sources'] };
export function useBasketDisplayQuotes(open: boolean, market: "india" | "us", instruments: string[], scope: string | null = null) {
  const keys = [...new Set(instruments)].sort().join(",");
  const [attempt, setAttempt] = useState(0);
  const request = useMemo(() => ({ open, market, keys, scope, attempt }), [open, market, keys, scope, attempt]);
  const [capabilities, setCapabilities] = useState<{ request: object | null; enabled: boolean | null }>({ request: null, enabled: null });
  const [state, setState] = useState<{ request: object | null; quotes: { instrument: string; isin?: string; price: number; as_of: string; source: string }[]; vendorQuotes?: UsVendorDisplayQuote[]; upstoxQuotes?: { instrument: string; isin?: string; price: number; as_of: string; source: string }[]; error?: string }>({ request: null, quotes: [] });
  useEffect(() => {
    if (!open || !keys) return;
    let active = true;
    const controller = new AbortController();
    const requested = keys.split(",");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let failures = 0;
    let nextRefresh = 0;
    const visible = () => document.visibilityState !== "hidden";
    // Completion-based scheduling prevents overlapping batches. Keep the request
    // identity stable during polling so quote updates never reset draft edits.
    const refresh = async () => {
      if (!active || running || !visible()) return;
      if (timer) clearTimeout(timer);
      running = true;
      try {
        const result = await load();
        if (active && result) setState({ request, ...result });
        failures = result?.batchFailed ? failures + 1 : 0;
      } catch (error: unknown) {
        failures += 1;
        if (active) setState({ request, quotes: [], error: error instanceof Error ? error.message : "Live display quotes are unavailable." });
      } finally {
        running = false;
        // HTTP failures (including rate limits) back off up to five minutes.
        const delay = failures ? Math.min(300_000, 30_000 * 2 ** Math.min(failures, 4)) : 30_000;
        nextRefresh = Date.now() + delay;
        if (active && market === "india" && requested.length <= 500 && visible()) timer = setTimeout(refresh, delay);
      }
    };
    const load = async () => {
      const quotes: { instrument: string; isin?: string; price: number; as_of: string; source: string }[] = [];
      const upstoxQuotes: typeof quotes = [];
      const vendorQuotes: UsVendorDisplayQuote[] = [];
      const warnings: string[] = [];
      let batchFailed = false;
      if (requested.length > 500) throw new Error("Display quote batch exceeds 500 instruments.");
      for (let offset = 0; offset < requested.length; offset += 50) {
        if (!active || market === "india" && !visible()) return null;
        const batch = requested.slice(offset, offset + 50);
        if (market === "us") {
          const supported = batch.filter(key => /^(NASDAQ|NYSE|NYSEARCA|NYSEAMERICAN):[A-Z0-9.-]{1,24}$/.test(key));
          if (supported.length !== batch.length) warnings.push("Some US listing identities are unsupported or ambiguous; verified listing mapping is required.");
          if (!supported.length) continue;
          const data = await apiService.indmoneyDisplayQuotes(supported);
          if (data.provider !== "Alpaca" || data.feed !== "iex" || !Array.isArray(data.quotes) || !Array.isArray(data.missing)) throw new Error("US vendor quote response scope is invalid.");
          for (const quote of data.quotes) {
            if (!supported.includes(quote.instrument) || quote.provider !== "Alpaca" || quote.feed !== "iex" || quote.currency !== "USD" || !quote.security_id || ({NASDAQ:"XNAS",NYSE:"XNYS",NYSEARCA:"ARCX",NYSEAMERICAN:"XASE"} as Record<string,string>)[quote.instrument.split(":")[0]] !== quote.listing_mic || !quote.share_class || !Number.isFinite(Date.parse(quote.as_of)) || !Number.isFinite(Date.parse(quote.received_at)) || Date.parse(quote.as_of) > Date.parse(quote.received_at) || !Number.isFinite(quote.price) || quote.price <= 0 || !quote.source?.startsWith("US vendor Alpaca")) throw new Error("US vendor quote identity, time or price is invalid.");
            vendorQuotes.push(quote);
            quotes.push({ instrument: quote.instrument, price: quote.price, as_of: quote.as_of, source: `${quote.source} · received ${quote.received_at} · ${quote.delay_reason ?? "IEX last trade"} · ${quote.session}` });
          }
          warnings.push(...data.missing.map(row => row.reason));
          continue;
        }
        try {
          const data = await apiService.zerodhaDisplayQuotes(batch, controller.signal);
          if (!Array.isArray(data.quotes) || !Array.isArray(data.missing) || data.quotes.some(quote => !batch.includes(quote.instrument))) throw new Error("Quote response does not match this basket.");
          if (data.upstox_quotes !== undefined && (!Array.isArray(data.upstox_quotes) || data.upstox_quotes.some(quote => !batch.includes(quote.instrument) || !quote.source?.startsWith("Upstox ")))) throw new Error("Upstox response does not match this basket.");
          quotes.push(...data.quotes);
          upstoxQuotes.push(...(data.upstox_quotes ?? []));
        } catch (error) {
          if (!active || controller.signal.aborted) return null;
          batchFailed = true;
          warnings.push(error instanceof Error ? error.message : 'Quote request failed.');
        }
      }
      return { quotes, upstoxQuotes, vendorQuotes, batchFailed, ...(warnings.length ? { error: [...new Set(warnings)].join("; ") } : {}) };
    };
    const visibilityChanged = () => {
      if (timer) clearTimeout(timer);
      if (visible() && market === "india" && !running && requested.length <= 500) {
        // Returning to a visible tab refreshes when due. Repeated tab switches
        // cannot bypass the normal interval or an error cooldown.
        if (Date.now() < nextRefresh) timer = setTimeout(refresh, nextRefresh - Date.now());
        else void refresh();
      }
    };
    if (market === "india") document.addEventListener("visibilitychange", visibilityChanged);
    // US quotes retain their existing one-shot behavior, even in hidden tabs.
    if (market === "us") {
      void load().then(result => { if (active && result) setState({ request, ...result }); })
        .catch((error: unknown) => { if (active) setState({ request, quotes: [], error: error instanceof Error ? error.message : "Live display quotes are unavailable." }); });
    } else void refresh();
    return () => {
      active = false;
      controller.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [open, market, keys, request]);
  useEffect(() => {
    if (!open || market !== "india") return;
    let active = true;
    void apiService.zerodhaQuoteCapabilities?.().then(result => {
      if (active) setCapabilities({ request, enabled: result.upstox_ltp_enabled === true });
    }).catch(() => { if (active) setCapabilities({ request, enabled: false }); });
    return () => { active = false; };
  }, [open, market, request]);
  const current = open && state.request === request;
  return { retry: () => setAttempt(value => value + 1), quotes: current ? state.quotes : [], upstoxQuotes: current ? state.upstoxQuotes ?? [] : [], vendorQuotes: current ? state.vendorQuotes ?? [] : [], upstoxEnabled: open ? capabilities.request === request ? capabilities.enabled : false : null, error: current ? state.error : undefined, loading: Boolean(open && keys && !current) };
}

export function CalculationPopup({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { const opener = document.activeElement as HTMLElement | null; panel.current?.focus(); return () => opener?.focus(); }, []);
  return createPortal(<div role="dialog" aria-modal="true" aria-label={title} ref={panel} tabIndex={-1} className="fixed inset-0 z-[100] flex items-center justify-center overflow-auto bg-slate-950/60 p-4" onClick={event => { event.stopPropagation(); onClose(); }} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    if (event.key === "Tab") { const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled)') ?? []), first = nodes[0], last = nodes[nodes.length - 1]; if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first?.focus(); } }
  }}><section className="max-h-[85vh] w-full max-w-4xl overflow-auto rounded-2xl bg-white p-5 shadow-2xl" onClick={event => event.stopPropagation()}><div className="flex items-start justify-between gap-4"><h2 className="text-lg font-bold">{title}</h2><button type="button" onClick={onClose} className="rounded border px-3 py-2">Close</button></div>{children}</section></div>, document.body);
}
const number = (value: number | null | undefined) => value === null || value === undefined ? "Unavailable" : value.toLocaleString("en-IN", { maximumFractionDigits: 12 });
export function useBasketDisplayCalculations(open: boolean, market: "india" | "us", stocks: Stock[], totalAssets: number | null, snapshot: string | null, broker: string, assetInputs?: { portfolioValue: number | null; availableMargin: number | null }, policy: "listing-v1" | "issuer-v2" = "listing-v1") {
  const [parameters, setParameters] = useState(defaultDisplayParameters);
  const [result, setResult] = useState<{ request: object | null; data?: BasketScoreHistory; error?: string }>({ request: null });
  const [retry, setRetry] = useState(0);
  const [popup, setPopup] = useState<{ stock: Stock; kind: string; request: object; draftUnits?: number } | null>(null);
  const lower = -3, upper = 3, showAll = true;
  const symbols = [...new Set(stocks.map(s => s.symbol))].sort().join(",");
  const currentSignature = JSON.stringify(stocks.map(stock => [stock.symbol, stock.exchange, stock.score, stock.action, stock.scoreSources, stock.verifiedUsIdentity]));
  // The US basket previews a saved score scan. Opening it later must reproduce
  // the same rolling window, including its eligible rebalance and technical inputs.
  const latestSourceTime = market === "us" ? stocks.reduce((latest, stock) =>
    (stock.scoreSources ?? []).reduce((time, source) => {
      const timestamp = Date.parse(source.createdAt);
      return source.market === market && (source.completed || source.status === "partial") && Number.isFinite(timestamp)
        ? Math.max(time, timestamp) : time;
    }, latest), 0) : 0;
  const scanAsOf = latestSourceTime ? new Date(latestSourceTime).toISOString() : undefined;
  const signature = `${market}:${symbols}:${parameters.days}:${retry}:${snapshot ?? "missing"}:${currentSignature}`;
  // A scope may return to the same signature after close/empty preparation.
  // Bind results to this request cycle, not just its reusable scope string.
  const request = useMemo(() => ({ open, signature, valid: parameters.valid }), [open, signature, parameters.valid]);
  useEffect(() => {
    if (!open || !symbols || !parameters.valid) return;
    let active = true;
    void apiService.getBasketScoreHistory({ market, symbols: symbols.split(","), days: parameters.days, ...(scanAsOf ? { as_of: scanAsOf } : {}) }).then(data => {
      if ((scanAsOf && Date.parse(data.as_of) !== latestSourceTime) || data.market !== market || data.days !== parameters.days || !Array.isArray(data.symbols) || data.symbols.slice().sort().join(",") !== symbols || !Array.isArray(data.observations) || typeof data.truncated !== "boolean" || !Number.isFinite(Date.parse(data.as_of)) || !Number.isFinite(Date.parse(data.window_start)) || Date.parse(data.as_of) - Date.parse(data.window_start) !== parameters.days * 86400000) throw new Error("Historical score response scope does not match this basket.");
      if (active) setResult({ request, data });
    }).catch((error: unknown) => { if (active) setResult({ request, error: error instanceof Error ? error.message : "Historical scores could not be loaded." }); });
    return () => { active = false; };
  }, [open, market, symbols, parameters.days, parameters.valid, request, scanAsOf, latestSourceTime]);
  const data = open && result.request === request && parameters.valid ? result.data : undefined;
  const error = open && result.request === request ? result.error : undefined;
  const means = useMemo(() => new Map(stocks.map(stock => [stockIdentity(stock.symbol, stock.exchange), data ? historicalMean(data, stock.symbol, stock.exchange, { symbol: stock.symbol, exchange: stock.exchange, market, score: stock.score, ...allocationScoreContract(stock.score), action: stock.action, calculatedAt: data.as_of, sources: stock.identityIssue ? [] : stock.scoreSources ?? [] }, stock.verifiedUsIdentity) : { rows: [], sum: 0, score: null, excludedRows: [] }])), [stocks, data, market]);
  const listingEligible = (stock: Stock) => market === "india" || !stock.identityIssue && ['NASDAQ', 'NYSE', 'NYSEARCA', 'NYSEAMERICAN'].includes(stock.exchange.toUpperCase()) && new Set(stocks.filter(row => row.symbol.toUpperCase() === stock.symbol.toUpperCase()).map(row => row.exchange.toUpperCase())).size === 1;
  const listingAllocation = allocateDisplayScores(stocks.map(stock => ({ key: stockIdentity(stock.symbol, stock.exchange), score: listingEligible(stock) ? means.get(stockIdentity(stock.symbol, stock.exchange))?.score ?? null : null })), parameters);
  const india = market === "india" && policy === "issuer-v2" ? allocateIndiaEquities(stocks.map(stock => {
    const key = stockIdentity(stock.symbol, stock.exchange);
    return {key, isin: stock.isin ?? null, price: stock.upstoxLtp ?? null, holding: stock.holdingQuantity ?? null, score: means.get(key)?.score ?? null};
  }), parameters, totalAssets) : null;
  const allocation = india ? {
    denominator: india.denominator,
    weights: new Map(Array.from(india.venues, ([key, venue]) => [key, venue.weight])),
    selected: Array.from(india.venues, ([key, venue]) => ({key, score: venue.issuerScore})).filter(row => india.venues.get(row.key)!.weight > 0),
  } : listingAllocation;
  const loading = Boolean(open && symbols && parameters.valid && !data && !error);
  const metrics = (stock: Stock) => {
    const key = stockIdentity(stock.symbol, stock.exchange), mean = means.get(key), weight = allocation.weights.get(key);
    const sourceStock = stocks.find(row => stockIdentity(row.symbol, row.exchange) === key) ?? stock;
    const vendorVerified = sourceStock.vendorSource?.startsWith("US vendor ") && Number.isFinite(Date.parse(sourceStock.vendorAsOf ?? ""));
    const pricing = displaySizingPrice(market === "india" ? stock.ltp : vendorVerified ? sourceStock.vendorLtp : null, market === "india" ? stock.limitPrice : null), amount = brokerDisplayAllocation(weight, totalAssets, pricing.price, market);
    const venue = india?.venues.get(key);
    const target = (!india || venue && venue.issuerScore != null && venue.shares != null) && listingEligible(sourceStock) && !loading && !error && data && !data.truncated && parameters.valid && mean?.score != null ? weight ?? 0 : null;
    const comparison = weightComparison(sourceStock.currentValue, totalAssets, target);
    const held = market === "india" ? sellHoldingDisplay(sourceStock) : null;
    // Target columns always use target sizing; current holdings are separate popup evidence.
    const shown = india ? {stocks: target == null ? null : venue?.shares ?? null, amount: target == null || venue?.shares == null ? null : venue.shares === 0 ? 0 : venue.shares * venue.price!} : market === "india" && target === 0 ? {stocks: 0, amount: 0} : amount;
    const priceEvidence = sourceStock.upstoxSource?.startsWith("Upstox ") && Number.isFinite(Date.parse(sourceStock.upstoxAsOf ?? ""));
    const actionSizing = market === "india" ? basketActionSizing({ totalAssets, currentWeight: comparison.current, targetWeight: target, holdingQuantity: sourceStock.holdingQuantity ?? null, targetShares: india ? target == null ? null : venue?.shares : undefined, upstoxLtp: priceEvidence ? sourceStock.upstoxLtp ?? null : null }) : indmoneyActionSizing(target, totalAssets, sourceStock.investedValue ?? null, sourceStock.vendorSource?.startsWith("US vendor ") && Number.isFinite(Date.parse(sourceStock.vendorAsOf ?? "")) ? sourceStock.vendorLtp ?? null : null);

    if (india) {
      const delta = actionSizing.stocks;
      comparison.action = delta == null ? null : delta === 0 ? "Hold" : delta < 0 ? venue?.shares === 0 ? "Sell All" : "Trim" : sourceStock.holdingQuantity ? "Add More" : "Buy New";
    }
    return { key, mean, weight, pricing, amount, sourceStock, target, comparison, held, shown, actionSizing, venue };
  };
  const aggregate = allocationDisclosure(allocation.weights, Array.from(allocation.weights.keys(), key => {
    const stock = stocks.find(stock => stockIdentity(stock.symbol, stock.exchange) === key)!;
    if (india) return metrics(stock).shown?.amount ?? null;
    const price = metrics(stock).pricing;
    return stock.quoteLoading && price.basis !== "limit_estimate" ? null : brokerDisplayAllocation(allocation.weights.get(key), totalAssets, price.price, market)?.amount ?? null;
  }), totalAssets, Boolean(open && data && !data.truncated && !loading && !error && parameters.valid && stocks.length > 0 && Number.isSafeInteger(parameters.maximumStocks) && parameters.maximumStocks > 0 && Number.isFinite(parameters.cash) && parameters.cash >= 0 && parameters.cash <= 100 && Number.isFinite(parameters.normalised) && parameters.normalised >= 0 && parameters.normalised <= 100 && stocks.every(stock => (!india || metrics(stock).target != null) && means.get(stockIdentity(stock.symbol, stock.exchange))?.score != null)));
  const percentAggregate = (value: number | null) => value === null ? "Unavailable" : `${number(value * 100)}%`;
  const balanceCell = (amount: number | null | undefined) => {
    if (amount == null || !Number.isFinite(amount)) return "Unavailable";
    const formatted = formatBasketDisplayCurrency(amount, market === "india" ? "INR" : "USD");
    return totalAssets != null && totalAssets > 0
      ? formatted + " (" + (100 * amount / totalAssets).toFixed(2) + "%)"
      : formatted + " (—)";
  };
  const unavailableScores = data && !loading && !error && !data.truncated
    ? stocks.filter(stock => means.get(stockIdentity(stock.symbol, stock.exchange))?.score == null) : [];
  const comparing = Boolean(india && data && !data.truncated && stocks.some(stock => stock.savedComparison));
  const savedTargets = comparing && data && stocks.every(stock => stock.savedComparison) ? allocateIndiaEquities(stocks.map(stock => {
    const score = stock.savedComparison!.score;
    const historical = historicalMean(data, stock.symbol, stock.exchange, { symbol: stock.symbol, exchange: stock.exchange, market,
      score, ...allocationScoreContract(score), calculatedAt: data.as_of, sources: stock.identityIssue ? [] : stock.scoreSources ?? [] });
    return {key: stockIdentity(stock.symbol, stock.exchange), isin: stock.isin ?? null, price: stock.upstoxLtp ?? null,
      holding: stock.holdingQuantity ?? null, score: historical.score};
  }), parameters, totalAssets) : null;
  const displayScore = (score: number | null) => score == null ? "Unavailable" : ((Math.max(-3, Math.min(3, score)) + 3) * 100 / 6).toFixed(2);
  const renderDisclosure = (netPurchases: number | null = 0) => {
    const columns = [
      { label: "Current", investments: assetInputs?.portfolioValue, cash: assetInputs?.availableMargin },
      { label: "Recommended", investments: aggregate.roundedAmount, cash: aggregate.roundedResidual },
      { label: "Selected",
        investments: assetInputs?.portfolioValue != null && netPurchases != null ? assetInputs.portfolioValue + netPurchases : null,
        cash: assetInputs?.availableMargin != null && netPurchases != null ? assetInputs.availableMargin - netPurchases : null },
    ];
    return <section aria-label="Allocation disclosure" className="my-3 text-sm">
      <div className="mb-3 overflow-x-auto">
        <table aria-label="Portfolio allocation" className="w-full border-collapse text-sm tabular-nums">
          <thead><tr>{columns.map(column => <th key={column.label} scope="colgroup" colSpan={2} className="border p-2 text-center">{column.label}</th>)}</tr></thead>
          <tbody>{(["investments", "cash"] as const).map(key => <tr key={key}>
            {columns.flatMap(column => [
              <td key={column.label + "-label"} className="border px-3 py-2">{key === "investments" ? "Investments" : "Cash"}</td>,
              <td key={column.label} className="whitespace-nowrap border px-3 py-2 text-right">{balanceCell(column[key])}</td>
            ])}
          </tr>)}</tbody>
        </table>
      </div>
    {unavailableScores.length > 0 && data ? <section aria-label="Unavailable score reasons" className="mb-3 rounded border border-amber-500 p-3 text-amber-900 dark:text-amber-200">
      <h3 className="font-semibold">{unavailableScores.length} stock(s) need eligible score evidence</h3>
      <p>Selected score window: ({data.window_start}, {data.as_of}] · {data.timezone}. Missing scores are not zero or a recommendation to sell.</p>
      <ul>{unavailableScores.map(stock => {
        const reasons = scoreSourceIssues(data, stock.scoreSources ?? []);
        return <li key={stockIdentity(stock.symbol, stock.exchange)}><strong>{stockIdentity(stock.symbol, stock.exchange)}</strong>: {reasons.length ? reasons.join(' ') : 'No eligible saved observation or usable current calculation exists for this exact listing.'}</li>;
      })}</ul>
      <p>Next: review the source runs in Saved evidence and configuration. Current recommendations need eligible analysis in this window; a new scan requires separate review and may incur LLM costs. Opening this basket does not run a scan or refresh old evidence.</p>
    </section> : null}
    {comparing && <details open><summary>Saved and current settings compared at the same holdings and prices</summary>
      <table><thead><tr><th>Listing</th><th>Score /100 (saved → current)</th><th>Divisor (saved → current)</th><th>Target shares (saved → current)</th></tr></thead>
        <tbody>{stocks.map(stock => {
          const row = metrics(stock), saved = stock.savedComparison;
          return <tr key={row.key}><th>{row.key}</th><td>{displayScore(saved?.score ?? null)} → {displayScore(stock.score)}</td>
            <td>{saved?.divisor ?? "Unavailable"} → {saved?.currentDivisor ?? "Unavailable"}</td>
            <td>{savedTargets?.venues.get(row.key)?.shares ?? "Unavailable"} → {row.shown?.stocks ?? "Unavailable"}</td></tr>;
        })}</tbody></table></details>}
  </section>;
  };
  const units = (stock: Stock, label = market === 'india' ? 'Action Zerodha Stocks' : 'Action Indmoney Stocks', draftUnits?: number | null) => {
    const suggested = metrics(stock).actionSizing.stocks;
    const quantity = draftUnits !== undefined ? draftUnits : suggested;
    return <button type="button" className={draftUnits !== undefined ? "min-w-10 px-2 py-2 text-inherit transition-colors hover:brightness-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 rounded" : "whitespace-nowrap text-blue-700 transition-colors hover:text-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 rounded"} aria-label={`${stock.symbol} ${label} calculation`} onClick={() => setPopup({ stock, kind: market === "india" ? "Action Zerodha Stocks" : "Action Indmoney Stocks", request, ...(draftUnits !== undefined && draftUnits !== null ? { draftUnits } : {}) })}>{quantity === null ? "Unavailable" : `${draftUnits === undefined && quantity > 0 ? "+" : ""}${number(quantity)}`}</button>;
  };
  const cells = (stock: Stock) => {
    const { mean, weight, pricing, target, comparison, shown, actionSizing, sourceStock } = metrics(stock);
    const pct = (value: number | null) => value === null ? "Unavailable" : `${(value * 100).toFixed(2)}%`;
    const button = (kind: string, value: number | null | undefined, text?: string) => <button type="button" className="text-blue-700 transition-colors hover:text-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 rounded" title={kind === "Target Zerodha Stocks" || kind === "Target Zerodha Amount" ? pricing.label : undefined} aria-label={`${stock.symbol} ${kind} calculation`} onClick={() => setPopup({ stock, kind, request })}>{(loading || stock.quoteLoading && pricing.basis !== "limit_estimate" && (kind === "Target Zerodha Stocks" || kind === "Target Zerodha Amount")) ? <span role="status">Loading…</span> : text ?? number(value)}</button>;
    const labels = { actionStocks: `Action ${sizingBroker} Stocks`, actionAmount: `Action ${sizingBroker} Amount`, targetStocks: `Target ${sizingBroker} Stocks`, targetAmount: `Target ${sizingBroker} Amount` };
    const usd = market === "us" ? indmoneyActionSizing(target, totalAssets, metrics(stock).sourceStock.investedValue ?? null, actionSizing.price) : null;
    const targetShown = market === "india" ? shown : usd ? { stocks: usd.targetStocks, amount: usd.targetAmount } : null;
    const actionAmount = market === "india" ? formatBasketIntegerCurrency(actionSizing.amount, true) : actionSizing.amount === null ? "Unavailable" : `${actionSizing.amount > 0 ? "+" : ""}${formatBasketDisplayCurrency(actionSizing.amount, "USD")}`;
    const targetAmount = market === "india" ? formatBasketIntegerCurrency(targetShown?.amount) : formatBasketDisplayCurrency(targetShown?.amount, "USD");
    return <>
      <td className="whitespace-nowrap px-4 py-3">{button("Historical Weighted Score", mean?.score, mean?.score == null ? "Unavailable" : mean.score.toLocaleString("en-IN", { minimumFractionDigits: india ? 5 : 1, maximumFractionDigits: india ? 5 : 1 }))}
        {india && data && !loading && !error && <small className="block text-slate-600">
          {data.truncated ? "Incomplete history" : mean ? historyCoverage(mean.rows, data.timezone) : "Coverage unavailable"}
        </small>}
      </td>
      <td className="whitespace-nowrap px-4 py-3" title={market === "india" ? "Stock current value (settled + T1 units) ÷ (portfolio exposure (settled + T1) + available margin)" : "Stock current holdings value ÷ (Current Portfolio Holdings Value + Available Margin)"}>{pct(comparison.current)}</td>
      <td className="whitespace-nowrap px-4 py-3">{target === null ? "Unavailable" : button("Target Weight", target, pct(target))}</td>
      <td className={`whitespace-nowrap px-4 py-3 ${comparison.difference !== null && comparison.difference > 0 ? "text-emerald-600" : comparison.difference !== null && comparison.difference < 0 ? "text-red-600" : ""}`} title="Target Weight minus Current Weight (percentage points)">{comparison.difference !== null && comparison.difference > 0 ? "+" : ""}{pct(comparison.difference)}</td>
      <td className="whitespace-nowrap px-4 py-3"><span className={`rounded-full px-3 py-1 text-xs font-bold ${comparison.action === "Buy New" || comparison.action === "Add More" ? "bg-emerald-100 text-emerald-700" : comparison.action === "Sell All" || comparison.action === "Trim" ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-700"}`}>{comparison.action ?? "Unavailable"}</span>
        {india && <small className="block text-slate-600">
          Model mean change {sourceStock.modelUnits ?? "—"} shares<br />
          Target {pct(target)} · {actionSizing.stocks == null ? "Quantity unavailable" : actionSizing.stocks === 0 ? "Hold" : `${actionSizing.stocks < 0 ? "Sell" : "Buy"} ${Math.abs(actionSizing.stocks)} shares`}
        </small>}
      </td>
      <td className="px-4 py-3">{units(stock)}</td>
      <td className="whitespace-nowrap px-4 py-3"><button type="button" className="whitespace-nowrap text-blue-700 transition-colors hover:text-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 rounded" aria-label={`${stock.symbol} ${labels.actionAmount} calculation`} onClick={() => setPopup({ stock, kind: labels.actionAmount, request })}>{actionAmount}</button></td>
      <td className="whitespace-nowrap px-4 py-3">{weight !== undefined || target === 0 ? button(labels.targetStocks, targetShown?.stocks) : "—"}</td>
      <td className="whitespace-nowrap px-4 py-3">{weight !== undefined || target === 0 ? button(labels.targetAmount, targetShown?.amount, targetShown?.amount == null ? "Unavailable" : targetAmount) : "—"}</td>
    </>;
  };

  const sizingBroker = market === "india" ? "Zerodha" : "Indmoney";
  const headers = <>{["Historical Weighted Score", "Current Weight", "Target Weight", "Weight Difference", "Action New", `Action ${sizingBroker} Stocks`, `Action ${sizingBroker} Amount`, `Target ${sizingBroker} Stocks`, `Target ${sizingBroker} Amount`].map(label => <th key={label} data-column-label={label} className="px-4 py-3">{india && label === "Historical Weighted Score" ? `${parameters.days}-day mean of run scores (−3 to +3)` : label}</th>)}</>;

  const activePopup = open && popup?.request === request ? popup : null;
  const renderPopup = (netPurchases: number | null = 0) => {
  let popupContent: ReactNode = null;
  if (activePopup) {
    const popup = activePopup;
    const stock = stocks.find(row => stockIdentity(row.symbol, row.exchange) === stockIdentity(popup.stock.symbol, popup.stock.exchange)) ?? popup.stock, key = stockIdentity(stock.symbol, stock.exchange), mean = means.get(key), values = metrics(stock), weight = values.target ?? undefined, pricing = values.pricing;
    const derived = india ? { stocks: values.shown?.stocks ?? null, amount: values.shown?.amount ?? null, unroundedAmount: weight != null && totalAssets != null ? weight * totalAssets : null, unroundedStocks: weight != null && totalAssets != null && values.venue?.price ? weight * totalAssets / values.venue.price : null } : market === "india" && weight === 0 ? {stocks: 0, amount: 0, unroundedAmount: 0, unroundedStocks: 0} : brokerDisplayAllocation(weight, totalAssets, pricing.price, market);
    const history = popup.kind === "Historical Weighted Score";
    const percent = (value: number | null | undefined) => value == null ? "Unavailable" : `${(value * 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;
    const concise = (value: number | null | undefined) => value == null ? "Unavailable" : value.toLocaleString("en-IN", { maximumFractionDigits: 6 });
    const currency = (value: number | null | undefined) => value == null ? "Unavailable" : formatBasketDisplayCurrency(value, market === "india" ? "INR" : "USD");
    const isWeight = popup.kind === "Target Weight", isShares = popup.kind.includes("Stocks");
    const count = mean?.rows.length ?? 0;
    const currentObservation = mean?.rows.find(row => row.source_run_ids && row.scorePolicy === ALLOCATION_SCORE_POLICY);
    const capped = weight !== undefined && weight >= parameters.normalised / 100;
    const summary = {
      label: history ? "Historical weighted score" : isWeight ? "Portfolio allocation" : isShares ? "Calculated shares" : "Calculated allocation amount",
      value: loading ? "Loading…" : history ? concise(mean?.score) : isWeight ? percent(weight) : isShares ? concise(derived?.stocks) : market === "india" ? formatBasketIntegerCurrency(derived?.amount) : currency(derived?.amount),
      subtitle: history ? historyCoverage(mean?.rows ?? [], data?.timezone ?? "UTC") : isWeight ? weight === undefined ? "No eligible allocation" : capped ? "Capped at the maximum weight" : "Score-based allocation" : isShares ? `At ${currency(pricing.price)} per share` : market === "india" ? `${concise(derived?.stocks)} shares × ${currency(pricing.price)}` : "Portfolio allocation in USD; full calculation precision",
      metrics: history ? [{ label: "Lookback", value: scanAsOf ? `${parameters.days} days ending ${new Date(scanAsOf).toLocaleDateString("en-IN", { timeZone: data?.timezone ?? "UTC" })}` : `${parameters.days} days` }, { label: "Observations", value: String(count) }, { label: "Action", value: stock.action ?? "Unavailable" }, { label: "Raw formula score", value: concise(currentObservation?.rawScore) }, { label: "Effective allocation score", value: concise(currentObservation?.effectiveScore) }] : isWeight ? [{ label: "Score", value: concise(mean?.score) }, { label: "Weight cap", value: `${parameters.normalised}%` }, { label: "Min. cash", value: `${parameters.cash}%` }, { label: "Residual cash before rounding", value: percentAggregate(aggregate.residualWeight) }, { label: "Rounded aggregate target amount", value: formatBasketDisplayCurrency(aggregate.roundedAmount, market === "india" ? "INR" : "USD") }] : [{ label: isShares ? "Target weight" : "Shares", value: isShares ? percent(weight) : concise(derived?.stocks) }, { label: "Used price", value: currency(pricing.price) }, { label: isShares ? "Amount" : "Target weight", value: isShares ? currency(derived?.amount) : percent(weight) }],
      notice: loading ? "Loading saved history…" : error ? error : data?.truncated ? "History limit reached. Incomplete scores and allocations are unavailable." : !data ? "Valid portfolio inputs and saved history are required." : weight === 0 && !history && !isWeight && market === "india" ? "Zero Target Weight gives zero Target Stocks and Target Amount, independently of current holdings or price availability." : history ? count === 0 ? "No eligible observations are available in this window." : count === 1 ? "Only one eligible observation contributes in this view." : `${count} eligible observations contribute; overlapping runs count once.` : isWeight && india ? values.venue?.reason ?? "Verified issuer identity unavailable." : isWeight ? weight === undefined ? "This stock has no eligible positive-score allocation." : capped ? "The allocation has reached its configured cap." : "Allocation uses the eligible positive scores in this basket." : pricing.basis === "limit_estimate" ? "Uses the limit price. Live LTP is unavailable." : pricing.basis === "unavailable" ? "No valid price is available. See calculation details." : "Uses the quoted LTP shown in this row. See details for its timestamp.",
      warning: Boolean(error || data?.truncated || history && count <= 1 || !history && !isWeight && pricing.basis !== "quoted_ltp"),
      status: loading ? "loading" as const : error || data?.truncated ? "error" as const : undefined,
    };
    const held = market === "india" && (popup.kind === "Target Zerodha Stocks" || popup.kind === "Target Zerodha Amount") ? sellHoldingDisplay(stock) : null;
    if (market === "us" && /^(Action|Target) Indmoney/.test(popup.kind)) {
      const values = metrics(stock), source = values.sourceStock;
      const usd = indmoneyActionSizing(values.target, totalAssets, source.investedValue ?? null, values.actionSizing.price);
      const action = popup.kind.startsWith("Action"), shares = popup.kind.endsWith("Stocks");
      const value = action ? shares ? usd.stocks : usd.amount : shares ? usd.targetStocks : usd.targetAmount;
      popupContent = <BasketMetricPopup title={india && history ? `${parameters.days}-day mean of run scores (−3 to +3)` : popup.kind} eyebrow={`${stock.exchange}:${stock.symbol} / ${broker}`} summary={{ label: popup.kind, value: shares ? concise(value) : currency(value), subtitle: "USD allocation estimate · fractional shares", metrics: [{ label: "Target Weight", value: percent(values.target) }, { label: "Current invested amount", value: currency(source.investedValue) }, { label: "Alpaca IEX LTP", value: currency(usd.price) }], notice: "Display estimate only. Vendor quote time and source must be verified before execution.", warning: value === null }} onClose={() => setPopup(null)}>
        <p>Target Indmoney Amount ($) = Target Weight × (Current Portfolio Holdings Value + Available Margin) = {number(values.target)} × ({number(assetInputs?.portfolioValue)} + {number(assetInputs?.availableMargin)}) = {currency(usd.targetAmount)}.</p>
        <p>Target Indmoney Stocks = Target Indmoney Amount / Alpaca IEX LTP = {number(usd.targetStocks)}.</p>
        <p>Action Indmoney Amount ($) = Target Indmoney Amount − Current invested amount in this stock = {currency(usd.targetAmount)} − {currency(source.investedValue)} = {currency(usd.amount)}.</p>
        <p>Action Indmoney Stocks = Action Indmoney Amount / Alpaca IEX LTP = {number(usd.stocks)}.</p>
        <p>Source: {source.vendorSource ?? "Unavailable"}. Observed at: {source.vendorAsOf ?? "Unavailable"}. No whole-share rounding or minimum is applied. Missing inputs stay unavailable. Display currency rounds to cents; calculations retain precision.</p>
      </BasketMetricPopup>;
    } else if (market === "india" && (popup.kind === "Action Zerodha Stocks" || popup.kind === "Action Zerodha Amount")) {
      const calculation = basketActionSizing({totalAssets, currentWeight: values.comparison.current, targetWeight: values.target, targetShares: india ? values.venue?.shares ?? null : undefined, holdingQuantity: values.sourceStock.holdingQuantity ?? null, upstoxLtp: values.sourceStock.upstoxSource?.startsWith("Upstox ") && Number.isFinite(Date.parse(values.sourceStock.upstoxAsOf ?? "")) ? values.sourceStock.upstoxLtp ?? null : null});
      popupContent = <BasketActionSizingPopup title={popup.kind} symbol={stock.symbol} exchange={stock.exchange} calculation={calculation} draftUnits={popup.draftUnits} portfolioValue={assetInputs?.portfolioValue} availableMargin={assetInputs?.availableMargin} snapshot={snapshot} priceSource={values.sourceStock.upstoxSource} priceAsOf={values.sourceStock.upstoxAsOf} holdingSource={values.sourceStock.holdingSource} onClose={() => setPopup(null)} />;
    } else {
    popupContent = <BasketMetricPopup key={`${key}:${popup.kind}`} title={india && history ? `${parameters.days}-day mean of run scores (−3 to +3)` : popup.kind} eyebrow={`${stock.exchange}:${stock.symbol} / ${broker}`} summary={summary} onClose={() => setPopup(null)}><>{history ? <AllocationScoreContext rawScore={stock.score} /> : null}{held && <section aria-label="Current holdings"><h3>Current Holdings</h3><p>Original basket action: {stock.action}. Current holding quantity: {number(held.stocks)}. Current holding value: {currency(held.amount)}.</p><p>Holding source: {stock.holdingSource ?? "Unavailable"}. Snapshot as of: {stock.holdingAsOf ?? "Unavailable"}. Settled and T1 holdings are included; this does not assert that T1 units can be sold.</p><p>Current holding value = quantity × genuine price = {number(held.stocks)} × {currency(held.price)} = {currency(held.amount)}. Price source: {held.source}. Price as of: {held.asOf ?? "Unavailable"}. No Limit Price estimate is used for current holdings.</p><p>{held.explanation} Current holdings are separate from Target sizing.</p></section>}<p className="my-3 text-sm">{broker} · {market === "india" ? "INR" : "USD"} · {stock.exchange}:{stock.symbol} · Portfolio snapshot {snapshot ?? "unavailable"} · LTP as of {stock.ltpAsOf ?? "unavailable"} · Quote source {stock.ltpSource ?? "No verified exact-venue quote"}</p>{loading ? <p role="status">Loading saved history…</p> : error ? <p role="alert">{error}</p> : !data ? <p>Valid portfolio inputs and saved history are required.</p> : <><p className="my-2 text-sm">{scanAsOf ? "Saved basket score window" : "Window"}: ({data.window_start}, {data.as_of}] · {data.timezone} · rolling {parameters.days} × 24 hours.</p>{history ? <><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>Run</th><th>Recorded / server-observed at</th><th>Action</th>{market === "us" ? <th>Original listing</th> : null}<th>Raw / original score</th><th>Score used in mean</th><th>Saved context</th></tr></thead><tbody>{mean?.rows.map(row => <tr key={row.id}><td>{row.source_run_ids ? `Current calculation · source runs ${row.source_run_ids.map(id => `#${id}`).join(", ")}` : `#${row.run_id}`}</td><td>{new Date(row.covered_at).toLocaleString("en-IN", { timeZone: data.timezone })}</td><td>{row.action ?? "Unavailable"}</td>{market === "us" ? <td>{row.exchange}:{row.symbol}</td> : null}<td>{number(row.source_run_ids && row.scorePolicy === ALLOCATION_SCORE_POLICY ? row.rawScore : row.score)}</td><td>{number(row.score)}</td><td>{row.formula_version}</td></tr>)}</tbody></table></div>{mean?.excludedRows.length ? <section aria-label="Excluded original scores" className="mt-3 text-sm"><h3>Excluded original scores</h3><ul>{mean.excludedRows.map(({ row, reason }, index) => <li key={`${row.id}:${index}`}>Run #{row.run_id} · {market === "us" ? `${row.exchange}:${row.symbol} · ` : ""}original score {number(row.score)} · {reason}</li>)}</ul></section> : null}<p className="mt-3 text-xs text-slate-600">Current calculation is observed at the server response as-of timestamp shown above. The browser clock is not used for eligibility. Original saved scores retain their original timestamps.</p><p className="mt-4">{india ? `${parameters.days}-day mean score` : "Historical Weighted Score"} = (effective score of the new current calculation, counted once + eligible original saved scores from other completed or partial runs) ÷ number of observations. Overlapping source runs are counted only in the current calculation.</p><p className="mt-2 break-words">({mean?.rows.map(row => number(row.score)).join(" + ") || "No observations"}) ÷ {mean?.rows.length ?? 0} = {number(mean?.score)}.</p></> : <div className="space-y-3">{renderDisclosure(netPurchases)}{india ? <section><p>{values.venue?.reason ?? "Verified ISIN unavailable"}. ISIN {values.venue?.issuer ?? "unavailable"}. Mean across venue scores {concise(values.venue?.issuerScore)}. Positive issuer denominator {concise(allocation.denominator)}.</p>
      <p>Issuer target {percent(values.venue?.issuerWeight)} · venue allocation {percent(weight)} · maximum {parameters.normalised}% · cash reserve {parameters.cash}%.</p>
      <p>Keep existing shares first. Route additions to one venue. Floor the venue budget in paise divided by the Upstox price in paise. Final target {concise(values.shown?.stocks)} shares at {currency(values.venue?.price)} = {currency(values.shown?.amount)}.</p></section> : <><p>Top {parameters.maximumStocks} strictly positive scores; ties use canonical exchange:symbol order. Denominator = {number(allocation.denominator)}. No cap redistribution.</p><p>Target Weight = MIN(score × (1 − Min Cash / 100) / denominator, Normalised Max Weight / 100)</p><p>MIN({number(mean?.score)} × (1 − {parameters.cash} / 100) / {number(allocation.denominator)}, {parameters.normalised} / 100) = {number(weight)} ({number(weight === undefined ? undefined : weight * 100)}%).</p>{market === "india" ? <p className={pricing.basis === "limit_estimate" ? "font-semibold text-amber-800" : ""}>{pricing.label}. Used price = {number(pricing.price)}. Quoted LTP = {number(stock.ltp)}; row Limit Price = {number(stock.limitPrice)}. Neither quoted price field is replaced by this display estimate.</p> : null}<p>Total Assets = {number(totalAssets)} {market === "india" ? "INR" : "USD"}; LTP = {number(market === "india" ? stock.ltp : pricing.price)}. Unrounded weight × assets = {number(derived?.unroundedAmount)}.</p>{market === "india" ? <><p>Target Zerodha Stocks = ROUND((Target Weight × Total Assets) / Used price, 0) = ROUND({number(derived?.unroundedStocks)}, 0) = {number(derived?.stocks)}.</p><p>Target Zerodha Amount = Target Zerodha Stocks × Used price = {number(derived?.stocks)} × {number(pricing.price)} = {formatBasketDisplayCurrency(derived?.amount, "INR")}.</p></> : <><p>Target Indmoney Amount (USD) = Target Weight × Total Assets = {number(derived?.unroundedAmount)} = {formatBasketDisplayCurrency(derived?.amount, "USD")}.</p><p>Target Indmoney Stocks = Amount / Alpaca IEX LTP = {number(derived?.amount)} / {number(pricing.price)} = {number(derived?.stocks)} (fractional).</p></>}<p>{weight === 0 && market === "india" ? "Zero Target Weight makes Target Zerodha Stocks and Target Zerodha Amount zero, independently of holdings or price availability. Current holdings and sell-all action quantities remain separate. " : ""}{market === "india" ? "Amount display rounds to nearest integer; intermediate values retain full precision." : "USD display rounds to cents; intermediate values and fractional shares retain full precision."}</p><p>{market === "india" ? "ROUND uses nearest whole number, with halves away from zero. " : "Fractional shares have no one-share minimum. "}Missing assets or a usable price remain unavailable; zero is shown only when actually calculated.</p></>}</div>}{data.notes.map(note => <p key={note} className="mt-3 text-xs text-slate-600">{note}</p>)}{data.truncated ? <p role="alert">History limit reached; incomplete averages and allocations are unavailable.</p> : null}</>}<p className="mt-4 font-semibold">Display calculation only. No order quantity or amount is changed.</p></></BasketMetricPopup>;
  }
  }
  return popupContent;
  };
  return { parameters, setParameters, cells, metrics, units, headers, renderDisclosure, renderPopup, popupOpen: Boolean(activePopup), lower, upper, showAll, loading, error, retry: () => setRetry(value => value + 1) };
}
