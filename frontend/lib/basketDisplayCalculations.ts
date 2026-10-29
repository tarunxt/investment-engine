export type SavedScoreObservation = { id: number | string; run_id: number; symbol: string; exchange: string | null; covered_at: string; score: number | null; action: string | null; formula_version: string; completed: boolean; eligible?: boolean; run_status?: string; coverage_status: string; source_run_ids?: number[] };
export type CurrentScoreCalculation = { symbol: string; exchange: string; market: 'india' | 'us'; score: number | null; action?: string | null; calculatedAt: string; sources: { runId: number; createdAt: string; completed: boolean; status?: string; market: 'india' | 'us' | null }[] };
export type BasketScoreHistory = { market: 'india' | 'us'; symbols: string[]; as_of: string; window_start: string; timezone: string; days: number; truncated: boolean; observations: SavedScoreObservation[]; notes: string[] };
export type DisplayParameters = { maximumStocks: number; days: number; cash: number; normalised: number; valid: boolean };
export const defaultDisplayParameters = (): DisplayParameters => ({ maximumStocks: 20, days: 5, cash: 5, normalised: 9.5, valid: true });
export const stockIdentity = (symbol: string, exchange: string) => `${exchange.toUpperCase()}:${symbol.toUpperCase()}`;
export function historicalMean(history: BasketScoreHistory, symbol: string, exchange: string, current?: CurrentScoreCalculation) {
  const start = Date.parse(history.window_start), end = Date.parse(history.as_of);
  const seen = new Set<number>();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || !Array.isArray(history.observations)) return { rows: [], sum: 0, score: null };
  const currentTime = Date.parse(current?.calculatedAt ?? '');
  const validCurrent = current && current.symbol.toUpperCase() === symbol.toUpperCase() && current.exchange.toUpperCase() === exchange.toUpperCase() && current.market === history.market && typeof current.score === 'number' && Number.isFinite(current.score) && current.score >= -3 && current.score <= 3 && currentTime > start && currentTime <= end && current.sources.length > 0 && current.sources.every(source => Number.isSafeInteger(source.runId) && source.runId > 0 && (source.completed === true || source.status === 'partial') && source.market === history.market && Date.parse(source.createdAt) > start && Date.parse(source.createdAt) <= end);
  const currentIds = new Set(validCurrent ? current.sources.map(source => source.runId) : []);
  const rows = history.observations.filter(row => {
    const time = Date.parse(row.covered_at);
    if (!row || typeof row.symbol !== 'string' || typeof row.exchange !== 'string' || !Number.isSafeInteger(row.run_id) || seen.has(row.run_id) || row.symbol.toUpperCase() !== symbol.toUpperCase() || row.exchange?.toUpperCase() !== exchange.toUpperCase() || (row.completed !== true && row.eligible !== true) || row.coverage_status !== 'suggested' || typeof row.score !== 'number' || !Number.isFinite(row.score) || row.score < -3 || row.score > 3 || time <= start || time > end || !Number.isFinite(time)) return false;
    if (currentIds.has(row.run_id)) return false;
    seen.add(row.run_id); return true;
  });
  if (validCurrent) rows.unshift({ id: `current:${[...currentIds].sort((a,b)=>a-b).join(',')}`, run_id: Math.max(...currentIds), source_run_ids: [...currentIds].sort((a,b)=>a-b), symbol, exchange, covered_at: current.calculatedAt, score: current.score, action: ['Sell All', 'Trim', 'Hold', 'Add more', 'Buy New'].includes(current.action ?? '') ? current.action! : null, formula_version: `Current calculation · displayed basket Score${current.sources.some(source => source.status === 'partial') ? ' · partially usable source output' : ''}; not an original saved decision`, completed: true, coverage_status: 'suggested' });
  const sum = rows.reduce((sum, row) => sum + row.score!, 0);
  return { rows, sum, score: history.truncated || !rows.length ? null : sum / rows.length };
}
export function allocateDisplayScores(stocks: { key: string; score: number | null }[], parameters: DisplayParameters) {
  const selected = parameters.valid && Number.isSafeInteger(parameters.maximumStocks) && parameters.maximumStocks > 0 ?  stocks.filter(row => typeof row.score === 'number' && Number.isFinite(row.score) && row.score > 0).sort((a, b) => b.score! - a.score! || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).slice(0, parameters.maximumStocks) : [];
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

export function toggleVisibleSelection(current: Set<string>, eligibleIds: string[]) {
  const ids = [...new Set(eligibleIds)], next = new Set(current);
  if (!ids.length) return next;
  const allSelected = ids.every(id => current.has(id));
  ids.forEach(id => { if (allSelected) next.delete(id); else next.add(id); });
  return next;
}
export function verifiedDisplayQuote(snapshot: unknown, market: 'india' | 'us', symbol: string, exchange: string): { price: number; asOf: string; source: string } | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const data = snapshot as Record<string, unknown>;
  if (typeof data.captured_at !== 'string' || !Number.isFinite(Date.parse(data.captured_at)) || !Array.isArray(data.holdings)) return null;
  if (market === 'india' ? !('holdings_market_value' in data) : data.parse_status !== 'parsed') return null;
  const venue = exchange.trim().toUpperCase();
  const canonical = (value: unknown) => {
    if (typeof value !== 'string') return '';
    let text = value.trim().toUpperCase();
    const prefix = /^([A-Z]+):(.+)$/.exec(text);
    if (prefix) { if (prefix[1] !== venue) return ''; text = prefix[2]; }
    if (market === 'india') {
      if (text.endsWith('.NS') && venue !== 'NSE' || text.endsWith('.BO') && venue !== 'BSE') return '';
      text = text.replace(/\.(?:NS|BO)$/, '');
    }
    return text;
  };
  if (!venue || !canonical(symbol)) return null;
  const matches = data.holdings.filter(holding => holding && typeof holding === 'object' && canonical(market === 'india' ? holding.tradingsymbol : holding.symbol) === canonical(symbol) && typeof holding.exchange === 'string' && holding.exchange.trim().toUpperCase() === venue);
  // No symbol-only fallback, purchase average, previous close, or guessed venue.
  if (matches.length !== 1) return null;
  const price = market === 'india' ? matches[0].last_price : matches[0].market_price;
  return typeof price === 'number' && Number.isFinite(price) && price > 0 ? { price, asOf: data.captured_at, source: market === 'india' ? 'Zerodha holdings last_price · exact venue' : 'IndMoney holdings market_price · explicit exact venue' } : null;
}

export function formatBasketDisplayCurrency(value: number | null | undefined, currency: 'INR' | 'USD' = 'INR') {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(currency === 'USD' ? 'en-US' : 'en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
}

export function verifiedFetchedDisplayQuote(quotes: { instrument: string; price: number; as_of: string; source: string }[], symbol: string, exchange: string) {
  const matches = quotes.filter(quote => quote.instrument === `${exchange.toUpperCase()}:${symbol.toUpperCase()}`);
  if (matches.length !== 1) return null;
  const quote = matches[0];
  return typeof quote.price === 'number' && Number.isFinite(quote.price) && quote.price > 0 && Number.isFinite(Date.parse(quote.as_of)) && typeof quote.source === 'string' && quote.source ? { price: quote.price, asOf: quote.as_of, source: quote.source } : null;
}

export function validDisplayPrice(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
export function displaySizingPrice(quoted: number | null | undefined, limit: number | null | undefined) {
  const quote = validDisplayPrice(quoted), estimate = validDisplayPrice(limit);
  return quote !== null ? { price: quote, basis: 'quoted_ltp', label: 'Quoted LTP shown in this row' } : estimate !== null ? { price: estimate, basis: 'limit_estimate', label: 'Estimate using Limit Price; not live LTP' } : { price: null, basis: 'unavailable', label: 'No valid Quoted LTP or Limit Price is available' };
}
