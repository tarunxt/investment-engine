import type {ScoreMatrixFormulaConfig} from '@/app/console/_components/FinalActionablesConsole';
export type AdvisoryRevision={schema:1;id:string;revision:number};
const field='_credx_advisory_revision';
/** Owner-local identity only; never a historical Run or governed-plan attestation. */
export function readAdvisoryRevision(value:unknown):AdvisoryRevision|null{
 if(value===null||typeof value!=='object'||!Object.prototype.hasOwnProperty.call(value,field))return null;
 const item=(value as Record<string,unknown>)[field] as AdvisoryRevision;
 if(!item||item.schema!==1||typeof item.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(item.id)||!Number.isSafeInteger(item.revision)||item.revision<1)throw Error('Stored advisory revision is unverified; original preference retained');
 return{schema:1,id:item.id,revision:item.revision};
}
export function versionAdvisoryConfiguration(config:ScoreMatrixFormulaConfig,previous:unknown,id:string){
 const prior=readAdvisoryRevision(previous),revision=(prior?.revision??0)+1;
 const value={...config,[field]:{schema:1 as const,id,revision}};readAdvisoryRevision(value);return value;
}
