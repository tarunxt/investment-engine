/** Pure, fail-closed identity resolution. Model venue/name alone is not verified metadata. */
export type VerifiedUsListing = {
  instrument: string; symbol: string; listing_mic: string; share_class: string;
  security_id: string; vendor_symbol: string; currency: 'USD'; verified: true;
};
export type UsIdentityInput = { symbol: string; exchange: string; shareClass?: string | null };
export type UsIdentity = {
  key: string; symbol: string; exchange: string; listing: VerifiedUsListing | null;
  issue: string | null; holdingSafe: boolean;
};
const mic: Record<string,string> = {NASDAQ:'XNAS',NYSE:'XNYS',NYSEARCA:'ARCX',NYSEAMERICAN:'XASE'};
const venue = (value: string) => ({AMEX:'NYSEAMERICAN',ARCA:'NYSEARCA'}[value.trim().toUpperCase()] ?? value.trim().toUpperCase());
const symbolOf = (value: string) => value.trim().toUpperCase().replace(/^(?:US|NASDAQ|NYSE|NYSEARCA|NYSEAMERICAN|AMEX|ARCA):/, '');
export function validatedUsListings(input: readonly VerifiedUsListing[]): VerifiedUsListing[] {
  if (!Array.isArray(input) || input.length > 1000) return [];
  const rows = input.filter(row => row && row.verified === true && row.currency === 'USD'
    && typeof row.instrument === 'string' && typeof row.symbol === 'string'
    && row.instrument === `${venue(row.instrument.split(':')[0])}:${row.symbol}`
    && /^[A-Z0-9.-]{1,24}$/.test(row.symbol) && /^[A-Z0-9.-]{1,24}$/.test(row.vendor_symbol)
    && mic[row.instrument.split(':')[0]] === row.listing_mic && Boolean(row.listing_mic)
    && typeof row.security_id === 'string' && Boolean(row.security_id.trim())
    && typeof row.share_class === 'string' && Boolean(row.share_class.trim()));
  const instruments = new Map<string,number>(), vendors = new Map<string,Set<string>>(), securities = new Map<string,Set<string>>();
  for (const row of rows) {
    instruments.set(row.instrument,(instruments.get(row.instrument) ?? 0)+1);
    const vendor = vendors.get(row.vendor_symbol) ?? new Set<string>();vendor.add(row.instrument);vendors.set(row.vendor_symbol,vendor);
    const key = JSON.stringify([row.security_id,row.listing_mic,row.share_class]), security = securities.get(key) ?? new Set<string>();security.add(row.instrument);securities.set(key,security);
  }
  return rows.filter(row => instruments.get(row.instrument) === 1 && vendors.get(row.vendor_symbol)?.size === 1 && securities.get(JSON.stringify([row.security_id,row.listing_mic,row.share_class]))?.size === 1);
}
export function resolveUsIdentity(input: UsIdentityInput, verified: readonly VerifiedUsListing[]): UsIdentity {
  return resolveUsIdentityFromListings(input,validatedUsListings(verified));
}
function resolveUsIdentityFromListings(input: UsIdentityInput, verified: readonly VerifiedUsListing[]): UsIdentity {
  const symbol = symbolOf(input.symbol);
  const prefix = /^(US|NASDAQ|NYSE|NYSEARCA|NYSEAMERICAN|AMEX|ARCA):/i.exec(input.symbol.trim());
  const suppliedVenue = venue(input.exchange || 'US');
  const exchange = suppliedVenue === 'US' && prefix ? venue(prefix[1]) : suppliedVenue;
  const all = verified.filter(row => row.symbol === symbol);
  const candidates = all.filter(row => (!input.shareClass || row.share_class.toUpperCase() === input.shareClass.trim().toUpperCase())
    && (exchange === 'US' || row.instrument.split(':')[0] === exchange));
  const unresolved = (issue: string): UsIdentity => ({key:`unresolved:${exchange}:${symbol}:${input.shareClass ?? '?'}`,symbol,exchange,listing:null,issue,holdingSafe:false});
  if (prefix && exchange !== 'US' && venue(prefix[1]) !== 'US' && venue(prefix[1]) !== exchange) return unresolved('Symbol prefix conflicts with the supplied explicit listing venue.');
  if (!['US', ...Object.keys(mic)].includes(exchange)) return unresolved('Unsupported US listing venue; verified mapping required.');
  if (!candidates.length) return unresolved('Verified US symbol, listing MIC and share-class mapping unavailable.');
  if (candidates.length !== 1) return unresolved('Multiple verified listings or share classes match this US alias; no listing was guessed.');
  const listing = candidates[0];
  return {key:`us:${JSON.stringify([listing.security_id,listing.listing_mic,listing.share_class])}`,symbol:listing.symbol,exchange:listing.instrument.split(':')[0],listing,issue:null,holdingSafe:all.length === 1};
}

export type IdentitySourceRow = { cells: Record<string,string>; meta: {runId:number;jobId:number} };
export function groupUsIdentityRows<T extends IdentitySourceRow>(rows: readonly T[], verified: readonly VerifiedUsListing[], actionHeader: string, normalizeAction: (value: string) => string | null) {
  const groups = new Map<string,{identity:UsIdentity;sourceRows:T[];decisionRows:T[];issue:string|null;sourceLinks:{runId:number;jobId:number;rowIndex:number;originalExchange:string;originalSymbol:string}[]}>();
  const bySymbol = new Map<string,VerifiedUsListing[]>();
  for (const listing of validatedUsListings(verified)) {const list=bySymbol.get(listing.symbol) ?? [];list.push(listing);bySymbol.set(listing.symbol,list);}
  const sourceOffsets = new Map<string,number>();
  rows.forEach((row) => {
    const sourceKey = `${row.meta.runId}:${row.meta.jobId}`, rowIndex = sourceOffsets.get(sourceKey) ?? 0;
    sourceOffsets.set(sourceKey,rowIndex+1);
    const rawSymbol = row.cells['Stock Symbol'] || row.cells['Stock Name'] || '';
    const identity = resolveUsIdentityFromListings({symbol:rawSymbol,exchange:row.cells['Exchange Symbol'] || 'US',shareClass:row.cells['Share Class'] || null},bySymbol.get(symbolOf(rawSymbol)) ?? []);
    const group = groups.get(identity.key) ?? {identity,sourceRows:[],decisionRows:[],issue:identity.issue,sourceLinks:[]};
    group.sourceRows.push(row);group.sourceLinks.push({runId:row.meta.runId,jobId:row.meta.jobId,rowIndex,originalExchange:row.cells['Exchange Symbol'] || '',originalSymbol:row.cells['Stock Symbol'] || ''});groups.set(identity.key,group);
  });
  for (const group of groups.values()) {
    const bySource = new Map<string,T[]>();
    group.sourceRows.forEach(row => {const key=`${row.meta.runId}:${row.meta.jobId}`,list=bySource.get(key) ?? [];list.push(row);bySource.set(key,list);});
    for (const sourceRows of bySource.values()) {
      const actions = new Set(sourceRows.map(row => normalizeAction(row.cells[actionHeader] || '') ?? 'Unavailable'));
      // One source gets one vote. Conflicting alias actions stay evidence, not two votes.
      if (actions.size > 1) {group.issue='The same source contains contradictory actions for verified aliases of one security.';continue;}
      if (actions.has('Unavailable')) {group.issue='A source observation has no valid action; original evidence requires review.';continue;}
      const signature = (row:T) => JSON.stringify(Object.entries(row.cells).filter(([key]) => !['Exchange Symbol','Stock Symbol','Stock Name','Share Class'].includes(key)).sort(([a],[b]) => a.localeCompare(b)));
      if (new Set(sourceRows.map(signature)).size > 1) {group.issue='The same source contains differing duplicate alias observations; review the original rows.';continue;}
      group.decisionRows.push(sourceRows[0]);
    }
  }
  return groups;
}

export function usIdentityHolding(identity: UsIdentity, snapshot: {parse_status:string;captured_at:string;holdings_count:number;reported_holdings_count:number|null;holdings:{symbol:string;quantity:number|null;current_value:number|null}[]} | null | undefined) {
  if (!identity.listing || !identity.holdingSafe || !snapshot || snapshot.parse_status !== 'parsed' || !Number.isFinite(Date.parse(snapshot.captured_at)) || snapshot.holdings_count !== snapshot.holdings.length || snapshot.reported_holdings_count !== null && snapshot.reported_holdings_count !== snapshot.holdings.length) return {holdingMatch:'unresolved' as const,currentUnits:null,currentInvestmentAmount:null};
  const matches=snapshot.holdings.filter(row => symbolOf(row.symbol) === identity.symbol);
  if (matches.length > 1) return {holdingMatch:'unresolved' as const,currentUnits:null,currentInvestmentAmount:null};
  if (!matches.length) return {holdingMatch:'absent' as const,currentUnits:0,currentInvestmentAmount:0};
  const finite=(value:number|null)=>typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  return {holdingMatch:'matched' as const,currentUnits:finite(matches[0].quantity),currentInvestmentAmount:finite(matches[0].current_value)};
}
