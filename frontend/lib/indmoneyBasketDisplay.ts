/** Display-only inputs. The caller must verify exact instrument/owner/snapshot joins and
 * Alpaca provenance and disclosed staleness before supplying a price. Never feed order readiness or sizing. */
export type IndmoneyDisplayInputs = {
  investedAmount: number | null;
  currentValue: number | null;
  sourceAsOf: string | null;
  price: number | null;
  priceAsOf: string | null;
  priceSource: string | null;
  unavailableReason: string | null;
};
const nonnegative = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const finite = (value: number | null) => value !== null && Number.isFinite(value) ? value : null;
export function indmoneyBasketDisplay(targetWeight: number | null | undefined, portfolioValue: number | null | undefined, availableMargin: number | null | undefined, input?: IndmoneyDisplayInputs) {
  const sum = nonnegative(portfolioValue) && typeof availableMargin === 'number' && Number.isFinite(availableMargin) ? finite(portfolioValue + availableMargin) : null;
  const assets = nonnegative(sum) ? sum : null;
  const target = nonnegative(targetWeight) ? targetWeight : null;
  const holdingVerified = Boolean(input?.sourceAsOf && Number.isFinite(Date.parse(input.sourceAsOf)));
  const invested = holdingVerified && nonnegative(input?.investedAmount) ? input.investedAmount : null;
  const currentValue = holdingVerified && nonnegative(input?.currentValue) ? input.currentValue : null;
  const price = input?.priceSource?.startsWith('Alpaca ') && input.priceAsOf && Number.isFinite(Date.parse(input.priceAsOf)) && nonnegative(input.price) && input.price > 0 ? input.price : null;
  const targetAmount = target === 0 ? 0 : assets !== null && target !== null ? finite(target * assets) : null;
  const actionAmount = targetAmount !== null && invested !== null ? finite(targetAmount - invested) : null;
  const targetStocks = targetAmount === 0 ? 0 : targetAmount !== null && price !== null ? finite(targetAmount / price) : null;
  const actionStocks = actionAmount === 0 ? 0 : actionAmount !== null && price !== null ? finite(actionAmount / price) : null;
  const current = assets !== null && assets > 0 && currentValue !== null ? finite(currentValue / assets) : null;
  const rawDifference = current !== null && target !== null ? finite(target - current) : null;
  const difference = rawDifference !== null && Math.abs(rawDifference) < 1e-12 ? 0 : rawDifference;
  const action = target === 0 && currentValue !== null ? (currentValue > 0 ? 'Sell All' : 'Hold') : difference === null ? null : difference > 0 ? current === 0 ? 'Buy New' : 'Add More' : difference < 0 ? 'Trim' : 'Hold';
  const missing = [target === null ? 'Eligible target weight unavailable.' : null, assets === null ? 'Portfolio holdings value or available margin unavailable.' : null, currentValue === null ? 'Verified current holding value unavailable.' : null, invested === null ? 'Verified invested cost unavailable.' : null, price === null ? 'Validated exact-instrument Alpaca price unavailable.' : null, input?.unavailableReason].filter(Boolean).join(' ');
  return { assets, target, invested, currentValue, price, targetAmount, targetStocks, actionAmount, actionStocks, current, difference, action, missing };
}
