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
export type BasketAttempt = { startedAt: string; state: 'in_flight' | 'uncertain'; listings: string[] };
export function basketAttemptKey(owner: number) { return `credx:zerodha:basket-attempt:v1:${owner}`; }
/** These responses precede this endpoint's order execution. Network/5xx/invalid responses are uncertain. */
export function definitiveBasketRejection(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'status' in error && [401, 403, 422].includes(Number(error.status));
}
