export type FlowStage={stage:string;status:string;checkpoint:Record<string,unknown>};
export type FlowRecommendation={instrument:string;action:string;current_units:string;final_units:string;allocation:string;[key:string]:unknown};
export type FlowOutput={state:'parsed'|'empty'|'missing'|'unparseable'|'incomplete'|'failed'|'partial';rows:FlowRecommendation[];job:number|null;hash:string|null};
const numeric=/^([+-]?)(?:(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d+))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;
function parts(raw:string):{coefficient:bigint;scale:number}|null{
 if(raw.length>128)return null;
 const text=raw.trim(),match=numeric.exec(text);if(!match)return null;
 const exponent=Number(match[5]??0);if(!Number.isSafeInteger(exponent)||Math.abs(exponent)>1024)return null;
 const fraction=match[3]??match[4]??'',whole=(match[2]??'0').replaceAll(',','');
 const coefficient=BigInt(whole+fraction)*(match[1]==='-'?-BigInt(1):BigInt(1));
 // Match the existing server's finite-cell domain without using float values
 // for subtraction or rendering the exact result.
 const finite=Number(text.replaceAll(',',''));
 if(!Number.isFinite(finite)||finite===0&&coefficient!==BigInt(0))return null;
 return {coefficient,scale:fraction.length-exponent};
}
/** Exact display arithmetic over the existing finite-number source syntax.
 * Unsupported display bounds stay unknown; this never calculates order units. */
export function unitDifference(final:string,current:string):string|null{
 const a=parts(final),b=parts(current);if(!a||!b)return null;
 const width=Math.max(a.scale,b.scale,0);
 const scaled=(value:{coefficient:bigint;scale:number})=>value.coefficient*BigInt(10)**BigInt(width-value.scale);
 const delta=scaled(a)-scaled(b),negative=delta<BigInt(0),raw=(negative?-delta:delta).toString().padStart(width+1,'0');
 const formatted=width?(raw.slice(0,-width)+'.'+raw.slice(-width)).replace(/\.?0+$/,''):raw;
 return (negative?'-':'')+(formatted||'0');
}
export function stockStageOutput(stage:FlowStage|undefined|null,sourceHash:string,currency:'INR'|'USD'):FlowOutput{
 if(!stage)return {state:'missing',rows:[],job:null,hash:null};
 const checkpoint=stage.checkpoint&&typeof stage.checkpoint==='object'?stage.checkpoint:{};
 const base={rows:[],job:null,hash:typeof checkpoint.result_hash==='string'&&/^[a-f0-9]{64}$/.test(checkpoint.result_hash)?checkpoint.result_hash:null};
 if(['failed','cancelled'].includes(stage.status))return {...base,state:'failed'};
 if(!['completed','partial'].includes(stage.status))return {...base,state:'incomplete'};
 const result=checkpoint.result as {data?:{response?:unknown;job_id?:unknown}}|undefined;
 if(typeof result?.data?.response!=='string'||!result.data.response.trim())return {...base,state:'missing'};
 try{
  const parsed=JSON.parse(result.data.response),ids=new Set<string>();
  if(parsed.schema_version!==1||parsed.currency!==currency||parsed.provenance?.input_hash!==sourceHash||!Array.isArray(parsed.recommendations)||parsed.recommendations.length>200)throw new Error();
  for(const row of parsed.recommendations){if(!row||typeof row.instrument!=='string'||!(/^[A-Z]+:[A-Z0-9&_.-]{1,64}$/).test(row.instrument)||ids.has(row.instrument)||!(currency==='USD'?['US','NYSE','NASDAQ','NYSEARCA','NYSEAMERICAN','AMEX']:['NSE','BSE']).includes(row.instrument.split(':')[0])||typeof row.action!=='string'||!['buy','add','trim','sell','hold'].includes(row.action)||!['current_units','final_units','allocation'].every(key=>typeof row[key]==='string'&&parts(row[key])!==null))throw new Error();ids.add(row.instrument);}
  return {state:stage.status==='partial'?'partial':parsed.recommendations.length?'parsed':'empty',rows:parsed.recommendations,job:Number.isSafeInteger(result.data.job_id)&&Number(result.data.job_id)>0?Number(result.data.job_id):null,hash:base.hash};
 }catch{return {...base,state:'unparseable'};}
}

/** Exact display-only product. Never a quote, funds result, charge or order validator. */
export function displayProduct(left:string,right:string):string|null{
 const a=parts(left),b=parts(right);if(!a||!b)return null;
 let coefficient=a.coefficient*b.coefficient;const scale=a.scale+b.scale,width=Math.max(0,scale);
 if(scale<0)coefficient*=BigInt(10)**BigInt(-scale);
 const negative=coefficient<BigInt(0),digits=(negative?-coefficient:coefficient).toString().padStart(width+1,'0');
 const value=(negative?'-':'')+(width?(digits.slice(0,-width)+'.'+digits.slice(-width)).replace(/\.?0+$/,'')||'0':digits);
 const finite=Number(value);return Number.isFinite(finite)&&!(finite===0&&coefficient!==BigInt(0))?value:null;
}
/** A drilldown may not silently follow a refreshed stage receipt. */
export function pinnedFlowRecommendation(output:FlowOutput,instrument:string|null,receipt:string|null):FlowRecommendation|null{return output.hash!==null&&receipt===output.hash?output.rows.find(row=>row.instrument===instrument)??null:null;}
