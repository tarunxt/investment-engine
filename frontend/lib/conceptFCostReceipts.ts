/** Exact saved USD receipt arithmetic. No FX, pricing lookup or provider call. */
/** Bounded exact display normalization of persisted Decimal strings. */
export function canonicalRecordedCost(value:unknown):string|null{
 if(typeof value!=='string'||value.length>64)return null;
 const match=/^(\d{1,24})(?:\.(\d{1,24}))?(?:[eE]([+-]?\d{1,3}))?$/.exec(value);if(!match)return null;
 const exponent=Number(match[3]??0);if(Math.abs(exponent)>24)return null;
 const fraction=match[2]??'',coefficient=BigInt(match[1]+fraction),scale=fraction.length-exponent;
 if(coefficient===BigInt(0))return '0';
 const digits=coefficient.toString(),padded=scale>0?digits.padStart(scale+1,'0'):digits;
 const whole=scale>0?padded.slice(0,-scale):padded+'0'.repeat(-scale),tail=scale>0?padded.slice(-scale).replace(/0+$/,''):'';
 const normalized=whole+(tail?'.'+tail:'');return /^\d{1,12}(?:\.\d{1,12})?$/.test(normalized)?normalized:null;
}
export function recordedCostTimestamp(value:unknown):string|null{
 if(typeof value!=='string'||value.length>64)return null;
 const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);if(!match)return null;
 const[,y,m,d,h,minute,second,oh,om]=match,calendar=new Date(0);calendar.setUTCFullYear(Number(y),Number(m)-1,Number(d));
 return Number(y)>0&&calendar.getUTCFullYear()===Number(y)&&calendar.getUTCMonth()===Number(m)-1&&calendar.getUTCDate()===Number(d)&&Number(h)<24&&Number(minute)<60&&Number(second)<60&&Number(oh??0)<24&&Number(om??0)<60&&Number.isFinite(Date.parse(value))?value:null;
}

export function recordedCosts(raw:unknown,expectedAttempts:number,jobHistory:unknown=[]){
 const input=Array.isArray(raw)?raw:[],frequencies=new Map<number,number>();for(const value of input.slice(0,200)){const number=value&&typeof value==='object'&&!Array.isArray(value)?(value as Record<string,unknown>).number:null;if(typeof number==='number'&&Number.isSafeInteger(number))frequencies.set(number,(frequencies.get(number)??0)+1);}let units=BigInt(0),incomplete=!Array.isArray(raw)||input.length===0||input.length!==expectedAttempts;const truncated=input.length>200;
 const rows=input.slice(0,200).map((value,index)=>{const row=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};const number=typeof row.number==='number'&&Number.isSafeInteger(row.number)&&row.number>0?row.number:null,duplicate=number!==null&&(frequencies.get(number)??0)>1;
 const text=canonicalRecordedCost(row.cost_usd),match=text?.match(/^(\d{1,12})(?:\.(\d{1,12}))?$/),valid=!!match&&number!==null&&number<=expectedAttempts&&!duplicate;
 if(valid)units+=BigInt(match![1])*BigInt(10)**BigInt(12)+BigInt((match![2]??'').padEnd(12,'0'));else incomplete=true;
 const linked=Array.isArray(jobHistory)?jobHistory.slice(0,200).flatMap(value=>{const entry=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};return entry.attempt===number&&typeof entry.job_id==='number'&&Number.isSafeInteger(entry.job_id)&&entry.job_id>0?[entry.job_id]:[];}):[];
 const direct=typeof row.job_id==='number'&&Number.isSafeInteger(row.job_id)&&row.job_id>0?row.job_id:null,candidate=linked.length===1?linked[0]:null;
 const job=duplicate||linked.length>1||direct!==null&&candidate!==null&&direct!==candidate?null:direct??candidate;
 return {key:index,number,duplicate,cost:valid?text:null,outcome:['completed','transient_failure','failed'].includes(String(row.outcome))?String(row.outcome):'Not recorded',at:recordedCostTimestamp(row.at),job};});
 incomplete=incomplete||truncated||!Number.isSafeInteger(expectedAttempts)||expectedAttempts<0;
 const digits=units.toString().padStart(13,'0'),fraction=digits.slice(-12).replace(/0+$/,'');const subtotal=digits.slice(0,-12)+(fraction?'.'+fraction:'');
 return {rows,knownSubtotal:rows.some(row=>row.cost!==null)?subtotal:null,total:!incomplete?subtotal:null,incomplete,truncated};
}
