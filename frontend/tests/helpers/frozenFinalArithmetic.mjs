// Differential fixture transport: execute actual component arithmetic functions.
// Display-only labels are stubbed; numeric helpers and setup registry are real.
import ts from 'typescript';
import { readFileSync } from 'node:fs';
process.on('uncaughtException', error => { console.error(error.message); process.exit(1); });
const root = new URL('../../', import.meta.url);
const files = [
  new URL('lib/technicalSetups.ts', root),
  new URL('lib/scoreMatrixMath.ts', root),
  new URL('app/console/_components/FinalActionablesConsole.tsx', root),
];
const functions = new Set([
  'buildScoreMatrixDetail', 'buildDetailedRationaleScoreRows', 'getTechnicalScanScoreMultiplier',
  'getTechnicalScanConfidence', 'formatTechnicalScanConfidenceValue', 'getFallbackTechnicalConfidence',
  'normalizeEmptyTechnicalValue', 'normalizeScanCell', 'stripInlineCitations', 'stripMarkdownLinks',
  'resolveApprovedTechnicalSetup', 'getApprovedSetupByName', 'normalizeSetupLookupKey',
  'findApprovedSetupInText', 'inferApprovedSetupFromText', 'getDefaultApprovedSetup',
  'getTechnicalTrendScore', 'formatTechnicalTrendValue', 'getAverageRationaleScoreCell',
  'parseRationaleScoreCell', 'parseStrictNumericCell', 'parseNumericCell', 'average', 'normalizeAction',
  'getSignedUnitsChange', 'getModeAction', 'evaluateScoreMatrixRules', 'resolveMatrixUnitsForAction',
  'clampScoreToGuardrail', 'buildFormulaActionEstimate', 'getMarketActionUnits', 'getActionAmount',
  'getStockPositionContext', 'buildPositionContext', 'getCurrentValueAmount', 'getCurrentInvestmentAmount',
  'getCurrentValueSnapshotForRow', 'normalizeStockSymbol',
  'buildConsensusRows', 'uniqueRunJobSources', 'buildCurrentValueSnapshotMap', 'getRunJobMetas', 'getMetaKey',
  'getStockKey', 'getRepresentativeConsensusRow', 'summarizeActionEstimate', 'getCurrentUnits',
  'getActionUnits', 'buildConsolidatedPositionCells', 'summarizeNumeric',
]);
const constants = new Set(['ACTION_SCORE_BY_CATEGORY', 'APPROVED_TECHNICAL_SETUPS', 'BULLISH_SETUPS', 'BEARISH_SETUPS']);
let code = `const ACTION_CATEGORIES=['Sell All','Trim','Add more','Buy New','Hold'];
const ACTION_HEADER='Action (Buy/Add/Sell All/Trim/Hold/Buy New)';
const ACTION_ESTIMATE_CATEGORIES=new Set(['Sell All','Trim','Add more','Buy New']);
const ACTION_CATEGORY_LABEL=Object.fromEntries(ACTION_CATEGORIES.map(a=>[a,a]));
const SCORE_GUARDRAIL_MIN=-3, SCORE_GUARDRAIL_MAX=3;
const TECHNICAL_SCAN_CONFIDENCE_MIN=0, TECHNICAL_SCAN_CONFIDENCE_MAX=10;
const formatDateTime=v=>v, parseTimestampMs=v=>Date.parse(v)||0;
const formatScanSourceLabel=()=>'', getPositionContextLabel=()=>'', buildMissingTechnicalScanReason=()=>'';
const formatTechnicalScanSourceLabel=()=>'';
const CURRENT_INVESTMENT_AMOUNT_HEADER='Current Value';
const getRunDisplayLabelForBreakup=()=> 'Synthetic', parseRunRows=run=>run.rows;
const getSwingScanBreakupEntriesForStock=()=>[], compareConsensusBreakupEntries=()=>0;
const summarizeRationales=()=>'', formatQuantity=String, formatCurrency=String, formatDisplayAmount=String;
`;
for (const url of files) {
  const source = readFileSync(url, 'utf8');
  if (url.pathname.endsWith('scoreMatrixMath.ts')) { code += source + '\n'; continue; }
  const ast = ts.createSourceFile(url.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement) && functions.has(statement.name?.text)) code += statement.getText(ast) + '\n';
    if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(d=>constants.has(d.name.getText(ast)))) code += statement.getText(ast) + '\n';
  }
}
code += `export function execute(fixture) {
  const rows=fixture.rows.map((cells,index)=>({cells,meta:{runId:10,jobId:11+index,runLabel:'Synthetic',provider:'test',model:'test',createdAt:'2026-01-01T00:00:00Z'}}));
  const run={id:10,rows,run_jobs:rows.map(row=>({job_id:row.meta.jobId,job:{provider:'test',model:'test',created_at:row.meta.createdAt,status:'completed'}}))};
  const stock=buildConsensusRows([run],fixture.market)[0];
  const detail=buildScoreMatrixDetail(stock,fixture.technical,fixture.formula);
  return {detail,setupDirections:Object.fromEntries(APPROVED_TECHNICAL_SETUPS.map(s=>[s.setup,s.direction])),estimate:buildFormulaActionEstimate(stock,detail.calculatedAction,detail.calculatedUnitsChange,fixture.market)};
}`;
const compiled=ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020}}).outputText;
const module=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
let input='';for await (const part of process.stdin) input+=part;
process.stdout.write(JSON.stringify(JSON.parse(input).map(module.execute)));
