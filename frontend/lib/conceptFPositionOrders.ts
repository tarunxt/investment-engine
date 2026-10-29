import {recordedCostTimestamp} from './conceptFCostReceipts';
import {recordedPositionGroup} from './conceptFPositions';
export function recordedNetM2M(raw:unknown){const group=recordedPositionGroup(raw);if(group.state!=='available'||!group.rows.length||group.rows.some(row=>row.m2m===null))return null;const total=group.rows.reduce((sum,row)=>sum+row.m2m!,0);return Number.isFinite(total)?total:null;}
export function positionOrderRows(raw:unknown){
 if(!Array.isArray(raw)||raw.length>50)return{rows:[],invalid:1};
 let invalid=0;const seen=new Set<string>();const rows=raw.flatMap(value=>{if(!value||typeof value!=='object'){invalid++;return[];}const row=value as Record<string,unknown>;if(row.module_id!=='zerodha_rebalance')return[];
 if(typeof row.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.id)||seen.has(row.id)||typeof row.state!=='string'||!/^[_a-z]{1,32}$/.test(row.state)||typeof row.unresolved!=='boolean'){invalid++;return[];}seen.add(row.id);
 const symbols=Array.isArray(row.legs)&&row.legs.length>0&&row.legs.length<=20&&row.legs.every(leg=>leg&&typeof leg==='object'&&['NSE','BSE'].includes(leg.exchange)&&typeof leg.symbol==='string'&&/^[A-Z0-9][A-Z0-9_.-]{0,31}$/.test(leg.symbol))?row.legs.map(leg=>leg.exchange+':'+leg.symbol):null;
 return[{id:row.id,state:row.state,created:recordedCostTimestamp(row.created_at),unresolved:row.unresolved||row.integrity_checked!==true||!['draft','validated','awaiting_approval','approved','filled','rejected','cancelled','invalidated'].includes(row.state),symbols}];});return{rows,invalid};
}
export function recordedUTCDay(value:string|null){const valid=recordedCostTimestamp(value);return valid?new Date(valid).toISOString().slice(0,10):null;}
export function validRecordedDay(value:string){if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;try{return new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;}catch{return false;}}
