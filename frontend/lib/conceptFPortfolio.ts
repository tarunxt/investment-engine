export type HoldingView={key:string;symbol:string;name:string;exchange:string|null;quantity:number|null;value:number|null;average:number|null;weight:number|null;dayChange:number|null;source:Record<string,unknown>};
export type PortfolioView={currency:'INR'|'USD';id:string;capturedAt:string|null;source:string;acceptance:string;total:number|null;cash:number|null;holdings:HoldingView[];invalidRows:number;net:Record<string,unknown>[];day:Record<string,unknown>[];raw:Record<string,unknown>};
const object=(x:unknown):Record<string,unknown>|null=>x!==null&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,unknown>:null;
const finite=(x:unknown)=>typeof x==='number'&&Number.isFinite(x)?x:null;
const text=(x:unknown)=>typeof x==='string'&&x.trim()?x.trim():null;
export function portfolioView(raw:unknown,portfolio:'india'|'indmoney_us'):PortfolioView|null {
 const x=object(raw);if(!x||!Array.isArray(x.holdings))return null;
 const india=portfolio==='india',currency=india?'INR':'USD';
 const total=finite(india?x.holdings_market_value:x.current_value);
 const holdings=x.holdings.flatMap((item,index)=>{
  const row=object(item);if(!row)return [];
  const symbol=text(india?row.tradingsymbol:row.symbol);if(!symbol)return [];
  const value=finite(india?row.market_value:row.current_value),exchange=india?text(row.exchange):null;
  const declaredWeight=finite(row.portfolio_weight_percent);
  return [{key:`${currency}:${exchange??''}:${symbol}:${index}`,symbol,name:text(row.company_name)??symbol,exchange,quantity:finite(row.quantity),value,average:finite(row.average_price),weight:declaredWeight??(india&&value!==null&&total!==null&&total>0?value/total*100:null),dayChange:finite(india?row.day_change_percentage:row.market_change_percent),source:row}];
 });
 const positions=object(x.positions);
 const groups=(v:unknown)=>Array.isArray(v)?v.flatMap(item=>{const row=object(item);return row?[row]:[];}):[];
 return {currency,id:text(x.source_receipt_id)??text(String(x.id??x.snapshot_date??''))??'Unverified source',capturedAt:text(x.captured_at),source:text(x.source)??'Source unavailable',acceptance:india?(x.source==='owned_synthetic_acquisition_journal_history'?'Historical owned journal; not current research or order authority':x.source==='owned_synthetic_acquisition_journal'&&typeof x.source_receipt_id==='string'?'Current owned journal used by governed research; captured fake prices only':'Recorded legacy simulation display; analysis acquisition is separate'):text(x.acceptance_state)??'legacy_unverified',total,cash:finite(india?x.available_margin:x.wallet_balance),holdings,invalidRows:x.holdings.length-holdings.length,net:groups(positions?.net),day:groups(positions?.day),raw:x};
}

/** A bounded list is not an ownership authority. Exact reads still require the
 * authenticated server owner predicate and, for timeline deep links, content hash. */
export function admitHistoricalUSSnapshot(raw:unknown,id:string,version:string|null,listed:boolean){
 const row=object(raw);if(!/^[1-9]\d{0,12}$/.test(id)||!row||String(row.id)!==id||!Array.isArray(row.holdings)||(!listed&&version===null)||version!==null&&(!/^[a-f0-9]{64}$/.test(version)||row.content_hash!==version))throw new Error('Exact owned snapshot identity and recorded version required');return row;
}
