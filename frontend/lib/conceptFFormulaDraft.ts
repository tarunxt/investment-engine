import type {ScoreMatrixFormulaConfig} from '@/app/console/_components/FinalActionablesConsole';
export const formulaGroups=['detailedRationaleMultipliers','actionScores','technicalScanMultipliers','scoreSymbolThresholds'] as const;
export function formulaDraft(config:ScoreMatrixFormulaConfig){return Object.fromEntries(formulaGroups.flatMap(group=>Object.entries(config[group]).map(([key,value])=>[group+':'+key,String(value)])));}
export function applyFormulaDraft(config:ScoreMatrixFormulaConfig,draft:Record<string,string>,denominator:string):ScoreMatrixFormulaConfig{
 const result=structuredClone(config);
 for(const group of formulaGroups)for(const key of Object.keys(config[group])){
  const value=draft[group+':'+key];if(typeof value!=='string'||!value.trim()||!Number.isFinite(Number(value)))throw new Error('Every formula field needs a finite number. Blank values are not zero.');
  (result[group] as Record<string,number>)[key]=Number(value);
 }
 if(denominator.trim()&&(!Number.isFinite(Number(denominator))||Number(denominator)<=0))throw new Error('Manual denominator must be positive, or blank for source automatic calculation.');
 result.detailedRationaleDenominator=denominator.trim()?Number(denominator):null;return result;
}
