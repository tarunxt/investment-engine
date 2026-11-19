import { allocateIndiaEquities, allocationScoreContract, defaultDisplayParameters, historicalMean, kiteHoldingQuantity, kiteWeightContext, stockIdentity, verifiedFetchedDisplayQuote } from "./basketDisplayCalculations";
import { apiService } from "@/services/api";
import type { ZerodhaPortfolioSnapshotDetail } from "@/types/api";
import type { CurrentScoreCalculation } from "./basketDisplayCalculations";

type Input = Pick<CurrentScoreCalculation, "exchange" | "symbol" | "score" | "action" | "sources">;

export async function captureIndiaValuation(sequence: number, asOf: string, snapshot: ZerodhaPortfolioSnapshotDetail, inputs: Input[]) {
  const parameters = defaultDisplayParameters();
  const instruments = inputs.map(row => stockIdentity(row.symbol, row.exchange));
  const symbols = [...new Set(inputs.map(row => row.symbol))].sort();
  const batches = Array.from({length: Math.ceil(instruments.length / 50)}, (_, index) => instruments.slice(index * 50, index * 50 + 50));
  if (!inputs.length || new Set(instruments).size !== inputs.length) throw new Error("Ambiguous valuation listings");
  const [historyRead, responses] = await Promise.all([
    apiService.getBasketScoreHistory({market:"india", symbols, days:parameters.days, as_of:asOf}).catch(() => null),
    Promise.allSettled(batches.map(batch => apiService.zerodhaDisplayQuotes(batch))),
  ]);
  const windowStart = new Date(Date.parse(asOf)-parameters.days*86400000).toISOString();
  const history = historyRead && !historyRead.truncated && historyRead.market === "india" &&
    historyRead.days === parameters.days && Date.parse(historyRead.as_of) === Date.parse(asOf) &&
    Date.parse(historyRead.window_start) === Date.parse(windowStart) && Array.isArray(historyRead.observations) &&
    Array.isArray(historyRead.symbols) && JSON.stringify([...historyRead.symbols].sort()) === JSON.stringify(symbols) ? historyRead : null;
  const failedQuoteListings = batches.flatMap((batch,i) => responses[i].status === "rejected" ? batch : []);
  const quotes = responses.flatMap((response,i) => response.status === "fulfilled" ?
    (response.value.upstox_quotes ?? []).filter(q => q.source?.startsWith("Upstox ") && batches[i].includes(q.instrument)) : []);
  const assets = kiteWeightContext(snapshot).totalAssets;
  const listings = inputs.map(input => {
    const {symbol, exchange} = input;
    const key = stockIdentity(symbol, exchange);
    const quote = verifiedFetchedDisplayQuote(quotes, symbol, exchange);
    const holding = kiteHoldingQuantity(snapshot, symbol, exchange)?.quantity ?? null;
    const exact = snapshot.holdings.filter(h => stockIdentity(h.tradingsymbol,h.exchange) === key);
    const ids = new Set([...exact.map(h => h.isin),quote?.isin].filter(Boolean));
    const id = ids.size === 1 ? [...ids][0] : null;
    const isin = id && !snapshot.holdings.some(h => h.isin === id && !instruments.includes(stockIdentity(h.tradingsymbol,h.exchange))) ? id : null;
    const mean = history ? historicalMean(history,symbol,exchange,{...input, market:"india", calculatedAt:history.as_of, ...allocationScoreContract(input.score)}) : null;
    return {key, isin, holding, price:quote?.price ?? null, priceAsOf:quote?.asOf ?? null, priceSource:quote?.source ?? null,
      score:mean?.score ?? null, currentIncluded:mean?.rows.some(row => row.source_run_ids) ?? false, prior:mean?.rows.filter(row => !row.source_run_ids) ?? [],
      quoteStatus:quote ? "available" : failedQuoteListings.includes(key) ? "batch_failed" : "unavailable",
      effectiveScore:allocationScoreContract(input.score).effectiveScore};
  });
  const {venues} = allocateIndiaEquities(listings,parameters,assets);
  const completeRanks = listings.every(r => r.score != null && r.isin != null && /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(r.isin));
  const baseline = listings.map(row => {
    const target = completeRanks ? venues.get(row.key)?.shares ?? null : null;
    const units = target != null && row.holding != null ? target - row.holding : null;
    return {listing:row.key, shares:target, units, targetRupees:target != null && row.price != null ? target*row.price : null,
      tradeRupees:units != null && row.price != null ? units*row.price : null};
  });
  return {schema:"india-valuation-v2", sequence, asOf, windowStart, historyAvailable:Boolean(history), failedQuoteListings, holdingsAsOf:snapshot.captured_at,
    cash:snapshot.available_margin, assets, parameters, holdings:snapshot.holdings.map(h => ({exchange:h.exchange, symbol:h.tradingsymbol,
      isin:h.isin, settled:h.quantity, t1:h.t1_quantity, lastPrice:h.last_price})), listings, baseline};
}
