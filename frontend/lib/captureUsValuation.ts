import { apiService } from "@/services/api";
import type { IndMoneyUsPortfolioSnapshotDetail } from "@/types/api";
import { allocateDisplayScores, allocationScoreContract, defaultDisplayParameters, historicalMean, indmoneyActionSizing, indmoneyHolding, stockIdentity, type CurrentScoreCalculation } from "./basketDisplayCalculations";
import { portfolioParameterAssets, portfolioParameterMargin } from "./portfolioParameters";
import type { UsIdentity } from "./usSecurityIdentity";

type Input = Pick<CurrentScoreCalculation, "exchange" | "symbol" | "score" | "action" | "sources"> & { identity?: UsIdentity; issue?: string | null };

export async function captureUsValuation(sequence: number, capturedAt: string, snapshot: IndMoneyUsPortfolioSnapshotDetail, inputs: Input[]) {
  const parameters = defaultDisplayParameters();
  const symbols = [...new Set(inputs.map(row => row.symbol))].sort();
  const latest = Math.max(...inputs.flatMap(row => row.sources.filter(source => source.market === "us" && (source.completed || source.status === "partial")).map(source => Date.parse(source.createdAt)).filter(Number.isFinite)));
  if (!Number.isFinite(latest)) throw new Error("Missing saved US score scan time");
  const asOf = new Date(latest).toISOString();
  const windowStart = new Date(latest - parameters.days * 86400000).toISOString();
  const eligible = inputs.filter(row => row.identity?.listing && !row.issue && new Set(inputs.filter(other => other.symbol === row.symbol).map(other => other.exchange)).size === 1);
  const instruments = eligible.map(row => stockIdentity(row.symbol, row.exchange));
  const batches = Array.from({length: Math.ceil(instruments.length / 50)}, (_, i) => instruments.slice(50*i, 50*(i+1)));
  const [response, responses] = await Promise.all([
    apiService.getBasketScoreHistory({market:"us", symbols, days:parameters.days, as_of:asOf}).catch(() => null),
    Promise.allSettled(batches.map(batch => apiService.indmoneyDisplayQuotes(batch))),
  ]);
  const history = response && response.market === "us" && !response.truncated && response.days === parameters.days &&
    Date.parse(response.as_of) === latest && Date.parse(response.window_start) === Date.parse(windowStart) &&
    JSON.stringify([...response.symbols].sort()) === JSON.stringify(symbols) ? response : null;
  const quotes = responses.flatMap((r,i) => r.status === "fulfilled" && r.value.provider === "Alpaca" && r.value.feed === "iex" ? r.value.quotes.filter(q => batches[i].includes(q.instrument)) : []);
  const assets = portfolioParameterAssets(snapshot, "us", portfolioParameterMargin(snapshot, "us")).totalAssets;
  const listings = inputs.map(input => {
    const {symbol, exchange, identity} = input;
    const key = stockIdentity(symbol, exchange);
    const listing = identity?.listing;
    const mean = history ? historicalMean(history, symbol, exchange, {...input, sources:input.issue ? [] : input.sources, market:"us", calculatedAt:asOf, ...allocationScoreContract(input.score)},
      listing ? {securityId:listing.security_id, exchangeAliases:identity.holdingSafe ? ["US"] : []} : undefined) : null;
    const evidence = quotes.filter(q => listing && q.instrument === key && q.security_id === listing.security_id && q.share_class === listing.share_class &&
      q.listing_mic === listing.listing_mic && q.vendor_symbol === listing.vendor_symbol && q.currency === "USD" && q.feed === "iex" && q.provider === "Alpaca" &&
      q.source.startsWith("US vendor Alpaca") && Date.parse(q.as_of) <= Date.parse(q.received_at) && Number.isFinite(q.price) && q.price > 0);
    const quote = evidence.length === 1 ? evidence[0] : null;
    const holding = identity?.holdingSafe && !input.issue ? indmoneyHolding(snapshot, symbol, exchange, inputs) : null;
    return {key, listing, eligible:instruments.includes(key), score:mean?.score ?? null, effectiveScore:allocationScoreContract(input.score).effectiveScore,
      currentIncluded:mean?.rows.some(row => row.source_run_ids) ?? false, prior:mean?.rows.filter(row => !row.source_run_ids) ?? [], excluded:mean?.excludedRows ?? [], quote, holding};
  });
  const {weights} = allocateDisplayScores(listings.filter(row => row.eligible), parameters);
  const baseline = listings.map(row => {
    const weight = row.eligible && row.score != null ? weights.get(row.key) ?? 0 : null;
    return {listing:row.key, weight, ...indmoneyActionSizing(weight, assets, row.holding?.investedValue ?? null, row.quote?.price ?? null)};
  });
  return {schema:"us-valuation-v1", sequence, capturedAt, asOf, windowStart, historyAvailable:Boolean(history), assets, parameters,
    snapshotId:snapshot.id, holdingsAsOf:snapshot.captured_at, listings, baseline,
    failedQuoteListings:batches.flatMap((batch,i) => responses[i].status === "rejected" ? batch : [])};
}
