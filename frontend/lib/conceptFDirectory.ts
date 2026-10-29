/** Source-backed discovery only. These entries never grant runtime capability. */
export const legacyDirectorySections:Record<string,{label:string;path:string;features:string[]}[]>={
 bullpen_research:[
  {label:'Bullpen007 research',path:'/console/bullpen-ai',features:['Scan setup and filters','Saved event analysis','Run audit: frozen inputs, outputs, validation and provenance','Per-model results, errors and consensus']},
  {label:'Bullpen008 shadow research',path:'/console/bullpen008',features:['Shadow review console','Saved event and run history']},
  {label:'Bullpen Sports research',path:'/console/bullpen-sports',features:['Sports scan review','Saved sports run details']},
  {label:'Trading bots overview',path:'/console/trading-bots',features:['Bot directory','Automation status and configuration','Per-bot saved activity']},
 ],
 bullpen_live:[{label:'Bullpen auto-live',path:'/console/trading-bots/bullpen-ai-auto-live',features:['Runtime configuration','Recorded positions and claim state','Run details; live activation remains separately restricted']}],
 copy_trader:[{label:'Copy trader',path:'/console/polymarket-bot',features:['Recorded copied positions and exposure limits','Trader, failure and skipped-reason details','Net-worth and trader-analysis details','Redeemed history','Operator commands and live actions require separate authority']}],
 prediction_direct:[{label:'Prediction direct',path:'/console/polymarket-direct-bot',features:['Runtime configuration','Recorded orders and positions','Execution remains separately restricted']}],
 market_scanner:[{label:'Technical setups',path:'/console/technical-setups',features:['Patterns and filters','Setup stock counts','Stock and per-model detail']}],
 ai_studio:[{label:'Prompt library',path:'/console/prompts',features:['Templates and classifications','Existing edit controls require verified permission']},{label:'Model performance',path:'/console/llms',features:['Provider and scan-type performance','Measured usage and costs']}],
 sheets_export:[{label:'Sheets export',path:'/console/google-sheets',features:['Connection and default destination','Private export review; no external send from this directory']}],
 sports_rankings:[{label:'Sports rankings',path:'/console/sports-rankings',features:['Competition and team sources','Rankings, comparison and filters']}],
};
