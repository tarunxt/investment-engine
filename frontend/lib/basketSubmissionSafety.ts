/** Reviewed draft affordability; sell proceeds remain estimates until backend reconciliation. */
export function basketAffordabilityIssue(orders: { side: string; amount: number | null; availableBalance?: number | null }[], margin: number | null): string | null {
  const buys = orders.filter(order => order.side === 'BUY');
  if (!buys.length) return null;
  if (margin === null || !Number.isFinite(margin) || margin < 0 || orders.some(order => order.amount === null || !Number.isFinite(order.amount) || order.amount < 0)) return 'Verified margin and draft amounts are required before buying.';
  const buyAmount = buys.reduce((sum, order) => sum + order.amount!, 0);
  const sellAmount = orders.filter(order => order.side === 'SELL').reduce((sum, order) => sum + order.amount!, 0);
  const required = buyAmount + Math.max(50, buyAmount * 0.01);
  return !Number.isFinite(required) || !Number.isFinite(sellAmount) || required > margin + sellAmount
    ? 'Selected buys exceed available margin plus estimated selected sales after the safety buffer. Reduce buy Units or review the sell-first basket.' : null;
}
export const UNCERTAIN_BASKET_MESSAGE = 'A previous order attempt may have reached Kite. Submission is blocked until that attempt is reconciled; a timeout does not cancel an order. Check the Kite order book and contact the operator to reconcile this attempt.';
export type BasketAttempt = { startedAt: string; state: 'in_flight' | 'uncertain' };
export function basketAttemptKey(owner: number) { return `credx:zerodha:basket-attempt:v1:${owner}`; }
/** These responses precede this endpoint's order execution. Network/5xx/invalid responses are uncertain. */
export function definitiveBasketRejection(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'status' in error && [401, 403, 422].includes(Number(error.status));
}

type ReviewedBasketDraft = { symbol: string; exchange: string; side: string; units: number | null };
/** A response resolves submission only when every reviewed unit has a consistent receipt or explicit skip. */
export function basketResponseIssue(response: unknown, drafts: ReviewedBasketDraft[]): string | null {
  if (!response || typeof response !== 'object') return 'Missing order response.';
  const data = response as Record<string, unknown>;
  if (!Array.isArray(data.sell_results) || !Array.isArray(data.buy_results) || !Array.isArray(data.skipped_buy_results)
    || !Array.isArray(data.messages) || !data.messages.every(message => typeof message === 'string')) return 'Malformed order response.';
  const expected = new Map<string, number>();
  const identity = (exchange: string, symbol: string, side: string) => `${exchange.toUpperCase()}:${symbol.toUpperCase()}:${side}`;
  for (const draft of drafts) {
    const key = identity(draft.exchange, draft.symbol, draft.side);
    if (!Number.isSafeInteger(draft.units) || draft.units! <= 0 || expected.has(key)) return 'Reviewed order identities or quantities are inconsistent.';
    expected.set(key, draft.units!);
  }
  const covered = new Map<string, number>(), receipts = new Set<string>(), resultKeys = new Set<string>();
  let placed = 0, failed = 0;
  for (const [bucket, side, skipped] of [[data.sell_results, 'SELL', false], [data.buy_results, 'BUY', false], [data.skipped_buy_results, 'BUY', true]] as const) {
    for (const value of bucket) {
      if (!value || typeof value !== 'object') return 'Malformed order result.';
      const row = value as Record<string, unknown>;
      if (typeof row.exchange !== 'string' || typeof row.tradingsymbol !== 'string' || row.transaction_type !== side
        || typeof row.quantity !== 'number' || !Number.isSafeInteger(row.quantity) || row.quantity <= 0
        || (skipped ? row.status !== 'skipped' : row.status !== 'placed' && row.status !== 'failed')) return 'Malformed order identity, side, status or quantity.';
      if (row.status !== 'placed' && row.order_id !== undefined && row.order_id !== null && row.order_id !== '') return 'A non-placed result unexpectedly contains a broker receipt.';
      const key = identity(row.exchange, row.tradingsymbol, side);
      if (!expected.has(key)) return 'Order response contains an unreviewed listing.';
      const resultKey = `${key}:${skipped ? 'skipped' : 'submitted'}`;
      if (resultKeys.has(resultKey)) return 'Duplicate order result.';
      resultKeys.add(resultKey);
      covered.set(key, (covered.get(key) ?? 0) + row.quantity);
      if (row.status === 'placed') {
        const receipt = typeof row.order_id === 'string' ? row.order_id.trim() : '';
        if (!receipt || receipts.has(receipt)) return 'A placed order has a missing or duplicate broker receipt.';
        receipts.add(receipt); placed++;
      } else if (row.status === 'failed') failed++;
    }
  }
  if (data.placed_count !== placed || data.failed_count !== failed || data.skipped_count !== data.skipped_buy_results.length) return 'Order response counts contradict its results.';
  if ([...expected].some(([key, quantity]) => covered.get(key) !== quantity)) return 'Order response does not account for every reviewed unit.';
  if (failed > 0) return 'A broker failure may have an uncertain execution outcome.';
  return null;
}
