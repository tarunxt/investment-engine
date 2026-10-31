export type BasketDraftContext = { action: string | null; suggestedUnits: number | null; source?: string; asOf?: string };
export function draftDirection(action: string | null | undefined): 'BUY' | 'SELL' | null {
  if (['Sell All','Trim','Sell'].includes(action ?? '')) return 'SELL';
  if (['Buy New','Add More','Add more','Buy'].includes(action ?? '')) return 'BUY';
  return null;
}
export function suggestedDraftUnits(signed: number | null | undefined): number | null {
  return typeof signed === 'number' && Number.isFinite(signed) ? Math.abs(signed) : null;
}
export function stepDraftUnits(units: number | null, delta: number): number {
  const value = units ?? 0;
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number.isInteger(value) ? value + delta : delta > 0 ? Math.ceil(value) : Math.floor(value)));
}
export function editableDraftAmount(units: number | null, price: number | null) {
  return typeof units === 'number' && Number.isFinite(units) && units >= 0 && typeof price === 'number' && Number.isFinite(price) && price > 0 && Number.isFinite(units * price) ? units * price : null;
}
export function editableDraftIssues(input: { units: number | null; price: number | null; currentUnits: number | null; exchange: string; side?: string; orderKind?: string; wholeShareReview?: string; draftContext?: BasketDraftContext }, now = Date.now()): string[] {
  const issues: string[] = [], context = input.draftContext, direction = draftDirection(context?.action);
  if (!['NSE','BSE'].includes(input.exchange)) issues.push('Unsupported exact exchange.');
  if (input.side !== undefined && input.side !== direction) issues.push('Order side does not match Action New direction.');
  if (input.orderKind !== undefined && input.orderKind !== 'Market') issues.push('This draft must remain Market; no silent LIMIT fallback.');
  if (!context || !direction) issues.push('Action New has no executable buy/sell direction.');
  if (input.units === null || !Number.isSafeInteger(input.units) || input.units <= 0) issues.push('Enter a positive whole-share quantity.');
  if (input.price === null || !Number.isFinite(input.price) || input.price <= 0 || !context?.source?.startsWith('Upstox ')) issues.push('Genuine Upstox LTP unavailable; no substitute price is used.');
  if (editableDraftAmount(input.units, input.price) === null && input.units !== null && input.price !== null) issues.push('Draft amount cannot be calculated as a finite Units × Upstox LTP value.');
  const asOf = Date.parse(context?.asOf ?? '');
  if (!Number.isFinite(asOf) || now - asOf > 120000 || asOf > now + 1000) issues.push('Upstox last trade is missing, old or future-dated; it is not a fresh execution quote.');
  if (direction === 'SELL') {
    if (input.currentUnits === null || !Number.isFinite(input.currentUnits)) issues.push('Verified exact-venue holding quantity is unavailable.');
    else if (input.units !== null && input.units > Math.floor(input.currentUnits)) issues.push('Sell quantity exceeds verified whole-share holdings.');
    if (context?.action === 'Trim' && input.currentUnits === 1 && input.units === 1 && input.wholeShareReview !== 'exit') issues.push('A one-share holding cannot be partially trimmed; explicit full-exit review is required.');
  }
  return issues;
}
