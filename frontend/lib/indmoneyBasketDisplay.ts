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

// NYSE published core-session calendar, https://www.nyse.com/trade/hours-calendars
const holidays = new Set((
  '2026-01-01 2026-01-19 2026-02-16 2026-04-03 2026-05-25 2026-06-19 2026-07-03 2026-09-07 2026-11-26 2026-12-25 ' +
  '2027-01-01 2027-01-18 2027-02-15 2027-03-26 2027-05-31 2027-06-18 2027-07-05 2027-09-06 2027-11-25 2027-12-24 ' +
  '2028-01-17 2028-02-21 2028-04-14 2028-05-29 2028-06-19 2028-07-04 2028-09-04 2028-11-23 2028-12-25'
).split(' '));
const earlyCloses = new Set(['2026-11-27', '2026-12-24', '2027-11-26', '2028-07-03', '2028-11-24']);
const eastern = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function usCoreSessionClosed(now = new Date()) {
  const parts = Object.fromEntries(eastern.formatToParts(now).map(p => [p.type, p.value]));
  const date = [parts.year, parts.month, parts.day].join('-');
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return ['Sat','Sun'].includes(parts.weekday) || holidays.has(date) || minutes < 570 || minutes >= (earlyCloses.has(date) ? 780 : 960);
}
