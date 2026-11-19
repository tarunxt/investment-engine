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
  const [history, responses] = await Promise.all([
    apiService.getBasketScoreHistory({market: "india", symbols, days: parameters.days, as_of: asOf}),
    Promise.all(batches.map(batch => apiService.zerodhaDisplayQuotes(batch))),
  ]);
  if (!inputs.length || new Set(instruments).size !== inputs.length || history.truncated || history.market !== "india" ||
      history.days !== parameters.days || Date.parse(history.as_of) !== Date.parse(asOf) ||
      Date.parse(history.as_of) - Date.parse(history.window_start) !== parameters.days * 86400000 ||
      JSON.stringify([...history.symbols].sort()) !== JSON.stringify(symbols)) throw new Error("Incomplete historical observation scope");
  const quotes = responses.flatMap((response,i) => (response.upstox_quotes ?? []).filter(q => q.source.startsWith("Upstox ") && batches[i].includes(q.instrument)));
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
    const mean = historicalMean(history,symbol,exchange,{...input, market:"india", calculatedAt:history.as_of, ...allocationScoreContract(input.score)});
    return {key, isin, holding, price:quote?.price ?? null, priceAsOf:quote?.asOf ?? null, priceSource:quote?.source ?? null,
      score:mean.score, currentIncluded:mean.rows.some(row => row.source_run_ids), prior:mean.rows.filter(row => !row.source_run_ids),
      effectiveScore:allocationScoreContract(input.score).effectiveScore};
  });
  const {venues} = allocateIndiaEquities(listings,parameters,assets);
  const baseline = listings.map(row => {
    const target = venues.get(row.key)?.shares ?? null;
    const units = target != null && row.holding != null ? target - row.holding : null;
    return {listing:row.key, shares:target, units, targetRupees:target != null && row.price != null ? target*row.price : null,
      tradeRupees:units != null && row.price != null ? units*row.price : null};
  });
  return {schema:"india-valuation-v1", sequence, asOf, windowStart:history.window_start, holdingsAsOf:snapshot.captured_at,
    cash:snapshot.available_margin, assets, parameters, holdings:snapshot.holdings.map(h => ({exchange:h.exchange, symbol:h.tradingsymbol,
      isin:h.isin, settled:h.quantity, t1:h.t1_quantity, lastPrice:h.last_price})), listings, baseline};
}
