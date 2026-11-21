import type { DashboardActionRow, ScoreMatrixFormulaConfig } from "@/app/console/_components/FinalActionablesConsole";
import type { CardFinal } from "./independentScorecards";
import { parseActionLabel } from "./actionColorScheme";

export function bindIndependentBasket(rows:DashboardActionRow[], final:CardFinal, formula:ScoreMatrixFormulaConfig) {
  const evidence=new Map(final.rows.map(row=>[row.listing,row]));
  const saved=new Map<string,{score:number}>();
  for (const source of final.rows) {
    if (source.signed != null) saved.set(source.listing, {score: source.signed});
  }
  const bound=rows.flatMap(row=>{
    const listing=row.stock.exchange+":"+row.stock.symbol;
    const source=evidence.get(listing);
    if(!source)return [];
    const action=source.action ? parseActionLabel(source.action) : null;
    const units=source.suggested_units;
    const price=source.price ?? Number(row.stock.representative["Price Per Unit"]);
    const estimate={currentUnits:source.settled,currentInvestmentAmount:source.value,
      units,amount:units!=null&&price!=null&&Number.isFinite(price)&&price>0?units*price:null};
    return [{...row,formulaScore:source.signed,formulaAction:action,formulaEstimate:estimate,
      independentEligible:source.status==="Complete" && source.signed!=null && source.settled!=null && source.action!=null,
      detail:{...row.detail,calculationPolicy:final.schema,calculatedScore:source.signed,detailedRationaleFinalScore:source.signed,
        calculatedAction:action,calculatedUnitsChange:units==null?null:action==="Sell All"||action==="Trim"?-units:units,
        technicalScanSourceRunId:final.source_runs.technical??null}}];
  });
  return {rows:bound,revision:{sequence:final.sequence,version:final.schema,formula,capturedAt:null,replayed:false,
    differences:[],divisors:[],originals:new Map<string,number>(),saved, finalRows:evidence}};
}

