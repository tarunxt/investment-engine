/** Pinned captured membership, never a current-risk or order authorization. */
export type EventHoldingTarget={row_index:number;owner_id:number;portfolio:'india'|'indmoney_us';instrument:string;source_id:string;source_version:string;source_hash:string;stock_key:string;captured_at:string};
type Context={owner:number;portfolio:'india'|'indmoney_us';available:boolean;sourceHash:string|null;capturedAt:string|null;rows:Record<string,string>[];indices:number[]};
const hash=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export function admitEventHoldingTargets(raw:unknown,context:Context):EventHoldingTarget[]{
 if(raw===undefined)return [];
 if(!Array.isArray(raw)||raw.length>200)throw new Error('Bounded captured holding targets required');
 const seen=new Set<number>();
 return raw.map(value=>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Captured holding target required');
  const t=value as EventHoldingTarget,india=context.portfolio==='india';
  const identity=india?typeof t.source_id==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(t.source_id):typeof t.source_id==='string'&&/^[1-9]\d{0,11}$/.test(t.source_id);
  const stock=typeof t.stock_key==='string'?t.stock_key.match(india?/^INR:([A-Z]+):([A-Z0-9&_.-]{1,64}):(\d{1,3})$/:/^USD:():([A-Z0-9&_.-]{1,64}):(\d{1,3})$/):null;
  const market=typeof t.instrument==='string'?t.instrument.match(/^([A-Z]+):([A-Z0-9&_.-]{1,64})$/):null;
  const row=context.rows[t.row_index];const eventInstrument=row?String(row.Exchange??'').trim().toUpperCase()+':'+String(row['Stock Symbol']??'').trim().toUpperCase():null;
  const time=typeof t.captured_at==='string'&&/T.*(?:Z|[+-]\d\d:\d\d)$/.test(t.captured_at)?Date.parse(t.captured_at):NaN;
  if(!Number.isSafeInteger(context.owner)||context.owner<1||!['india','indmoney_us'].includes(context.portfolio)||!context.available||t.owner_id!==context.owner||t.portfolio!==context.portfolio||!Number.isSafeInteger(t.row_index)||t.row_index<0||t.row_index>=context.rows.length||!context.indices.includes(t.row_index)||seen.has(t.row_index)||!identity||!hash(t.source_version)||!hash(t.source_hash)||t.source_hash!==context.sourceHash||t.captured_at!==context.capturedAt||!Number.isFinite(time)||time>Date.now()||!stock||Number(stock[3])>=200||!market||market[0]!==eventInstrument||market[2]!==stock[2]||(india?(!['NSE','BSE'].includes(market[1])||market[1]!==stock[1]):!['US','NASDAQ','NYSE','NYSEARCA','AMEX'].includes(market[1])))throw new Error('Exact captured holding identity could not be verified');
  seen.add(t.row_index);return t;
 });
}
export function eventHoldingHref(target:EventHoldingTarget){return (target.portfolio==='india'?'/console/zerodha':'/console/indmoney-us')+'/portfolio?'+new URLSearchParams({view:target.portfolio==='india'?'holdings':'portfolio',snapshot:target.source_id,snapshotVersion:target.source_version,stock:target.stock_key});}

export function validEventEnvelope(raw:unknown,owner:number,portfolio:'india'|'indmoney_us'){if(!raw||typeof raw!=='object'||Array.isArray(raw)||!Number.isSafeInteger(owner)||owner<1)return false;const v=raw as Record<string,unknown>;return v.schema_version===1&&v.owner_id===owner&&v.portfolio===portfolio&&v.simulation_only===true&&v.read_only===true&&v.live_calendar_verified===false&&v.scan_started===false;}
