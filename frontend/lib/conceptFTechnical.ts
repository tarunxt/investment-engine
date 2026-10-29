/** Display admission only. Calculations and integrity validation belong to the source service. */
const object=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const decimal=(v:unknown,places:number)=>typeof v==='string'&&new RegExp('^\\d{1,8}\\.\\d{'+places+'}$').test(v)&&Number.isFinite(Number(v))?v:null;
export function savedTechnicalSource(raw:unknown,owner:number){
 const source=object(raw),history=object(source?.price_history),study=object(history?.study);
 if(!source||!Object.hasOwn(source,'price_history'))return{state:'absent' as const};
 if(!history||!study||source.owner_id!==owner||source.portfolio!=='india'||source.currency!=='INR'||source.simulation_only!==true||!hash(source.content_hash)||!uuid(source.source_receipt_id)||history.owner_id!==owner||history.source_receipt_id!==source.source_receipt_id||history.schema_version!==1||history.provider!=='offline-fixed-samples-v1'||history.sample_kind!=='generated_test_samples_not_market_observations'||history.instrument!=='NSE:SYNTHETIC0'||history.currency!=='INR'||history.simulation_only!==true||history.orders_authorized!==false||!hash(history.history_hash)||study.schema_version!==1||study.algorithm!=='rsi14-initial-seed-and-sma-v1'||study.rsi_period!==14||study.orders_authorized!==false||study.volatility_classification!==null)return{state:'invalid' as const};
 const generated=typeof history.generated_at==='string'?Date.parse(history.generated_at):NaN,captured=typeof source.captured_at==='string'?Date.parse(source.captured_at):NaN;
 const samples=history.samples;
 if(!Number.isFinite(generated)||captured!==generated||!Array.isArray(samples)||samples.length!==15)return{state:'invalid' as const};
 const points=samples.map((item,index)=>{const sample=object(item),close=decimal(sample?.close,2),at=typeof sample?.sample_at==='string'?sample.sample_at:null;return close&&Number(close)>0&&Number(close)<=10000000&&at&&Date.parse(at)===generated-(14-index)*86400000?{at,close}:null;});
 const last=decimal(study.last_close,2),sma5=decimal(study.sma_5,4),sma14=decimal(study.sma_14,4),gain=decimal(study.gain_sum,2),loss=decimal(study.loss_sum,2),rsi=study.rsi_14===null?null:decimal(study.rsi_14,2);
 const holdings=source.holdings,holding=Array.isArray(holdings)&&holdings.length===1?object(holdings[0]):null;
 if(points.some(p=>p===null)||!last||!sma5||!sma14||!gain||!loss||study.rsi_14!==null&&(rsi===null||Number(rsi)>100)||!['above','below','equal'].includes(String(study.last_vs_sma_5))||points[14]?.close!==last||holding?.exchange!=='NSE'||holding?.tradingsymbol!=='SYNTHETIC0'||holding?.last_price!==last)return{state:'invalid' as const};
 return{state:'available' as const,points:points as {at:string;close:string}[],last,sma5,sma14,gain,loss,rsi,trend:String(study.last_vs_sma_5),receipt:String(source.source_receipt_id),hash:String(history.history_hash),generated:String(history.generated_at),instrument:'NSE:SYNTHETIC0'};
}
