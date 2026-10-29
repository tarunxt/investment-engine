import type {StockConsensus} from '@/app/console/_components/FinalActionablesConsole';
import {unitDifference} from './conceptFStockFlow';
/** Original selected model cells only. The grouping's current-units projection
 * is not evidence of captured holdings; disagreement must not become zero. */
export function recordedSetupUnits(stock:StockConsensus|undefined):string|null{
 if(!stock?.rows.length)return null;
 const values=stock.rows.map(row=>row.cells['Current Units']);
 const first=values[0];
 if(typeof first!=='string'||unitDifference(first,'0')===null)return null;
 return values.every(value=>typeof value==='string'&&unitDifference(value,first)==='0')?first:null;
}
