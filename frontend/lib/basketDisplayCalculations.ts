export type SavedScoreObservation = { id: number; run_id: number; symbol: string; exchange: string | null; covered_at: string; score: number | null; action: string | null; formula_version: string; completed: boolean; coverage_status: string };
export type BasketScoreHistory = { market: 'india' | 'us'; symbols: string[]; as_of: string; window_start: string; timezone: string; days: number; truncated: boolean; observations: SavedScoreObservation[]; notes: string[] };
export type DisplayParameters = { maximumStocks: number; days: number; cash: number; normalised: number; valid: boolean };
export const defaultDisplayParameters = (): DisplayParameters => ({ maximumStocks: 20, days: 5, cash: 5, normalised: 9.5, valid: true });
export const stockIdentity = (symbol: string, exchange: string) => `${exchange.toUpperCase()}:${symbol.toUpperCase()}`;
export function historicalMean(history: BasketScoreHistory, symbol: string, exchange: string) {
  const start = Date.parse(history.window_start), end = Date.parse(history.as_of);
  const seen = new Set<number>();
  const rows = history.observations.filter(row => {
    const time = Date.parse(row.covered_at);
    if (seen.has(row.run_id) || row.symbol.toUpperCase() !== symbol.toUpperCase() || row.exchange?.toUpperCase() !== exchange.toUpperCase() || !row.completed || row.coverage_status !== 'suggested' || typeof row.score !== 'number' || !Number.isFinite(row.score) || row.score < -3 || row.score > 3 || time <= start || time > end || !Number.isFinite(time)) return false;
    seen.add(row.run_id); return true;
  });
  const sum = rows.reduce((sum, row) => sum + row.score!, 0);
  return { rows, sum, score: history.truncated || !rows.length ? null : sum / rows.length };
}
export function allocateDisplayScores(stocks: { key: string; score: number | null }[], parameters: DisplayParameters) {
  const selected = parameters.valid ? stocks.filter(row => typeof row.score === 'number' && Number.isFinite(row.score) && row.score > 0).sort((a, b) => b.score! - a.score! || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).slice(0, parameters.maximumStocks) : [];
  const denominator = selected.reduce((sum, row) => sum + row.score!, 0);
  const weights = new Map<string, number>();
  if (Number.isFinite(denominator) && denominator > 0 && parameters.cash >= 0 && parameters.cash <= 100 && parameters.normalised >= 0 && parameters.normalised <= 100) {
    for (const row of selected) weights.set(row.key, Math.min(row.score! * (1 - parameters.cash / 100) / denominator, parameters.normalised / 100));
  }
  return { denominator, selected, weights };
}
// Excel ROUND(x, 0): halfway values round away from zero. Display allocations are nonnegative.
export const excelRound = (value: number) => Math.sign(value) * Math.floor(Math.abs(value) + 0.5);
export function brokerDisplayAllocation(weight: number | undefined, assets: number | null, ltp: number | null, market: 'india' | 'us') {
  if (weight === undefined || !Number.isFinite(weight) || weight < 0 || assets === null || !Number.isFinite(assets) || assets < 0) return null;
  const unroundedAmount = weight * assets;
  if (!Number.isFinite(unroundedAmount)) return null;
  const validPrice = ltp !== null && Number.isFinite(ltp) && ltp > 0;
  if (market === 'us') {
    const amount = excelRound(unroundedAmount);
    return { unroundedAmount, unroundedStocks: validPrice ? amount / ltp! : null, amount, stocks: validPrice ? amount / ltp! : null };
  }
  if (!validPrice) return { unroundedAmount, unroundedStocks: null, amount: null, stocks: null };
  const unroundedStocks = unroundedAmount / ltp!, stocks = excelRound(unroundedStocks);
  return { unroundedAmount, unroundedStocks, amount: stocks * ltp!, stocks };
}
export function displayScoreAccepted(score: number | null, lower: number, upper: number, showAll: boolean) {
  return showAll || typeof score === 'number' && Number.isFinite(score) && score >= -3 && score <= 3 && (score <= lower || score >= upper);
}
