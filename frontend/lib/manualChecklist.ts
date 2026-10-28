export const manualSteps=['review_plan','check_account','record_outcome'] as const;
export type ManualStep=typeof manualSteps[number];
export type ChecklistBinding={owner:number;run:number;source:string;plan:string};
export function checklistKey(binding:ChecklistBinding){return 'credx:manual-checklist:v1:'+encodeURIComponent(JSON.stringify(binding));}
export function checklistState(raw:string|null,binding:ChecklistBinding):Record<ManualStep,boolean>{
 const empty={review_plan:false,check_account:false,record_outcome:false};try{const row=JSON.parse(raw??'null');if(row?.schema!==1||JSON.stringify(row.binding)!==JSON.stringify(binding)||manualSteps.some(step=>typeof row.steps?.[step]!=='boolean'))return empty;return Object.fromEntries(manualSteps.map(step=>[step,row.steps[step]])) as Record<ManualStep,boolean>;}catch{return empty;}
}
