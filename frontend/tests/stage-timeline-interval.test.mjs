import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatApiTimestamp, parseApiTimestamp } from '../lib/datetime.ts';

const source = readFileSync(new URL('../app/console/auto-rebalance-runs/_components/AutoRebalanceHistoryClient.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('history.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const names = ['statusTone','stageCardTone','formatTime','formatCost','StatusBadge','StageSummary'];
const functions = ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.includes(node.name?.text)).map(node=>node.getText(ast)).join('\n');
const compiled = ts.transpileModule(functions,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const StageSummary = new Function('exports','require','STAGE_LABELS','formatApiTimestamp','parseApiTimestamp','AlertCircle',compiled+'\nreturn StageSummary;')(
  {},name=>{assert.equal(name,'react/jsx-runtime');return jsxRuntime;}, {actionables:'Actionables'},formatApiTimestamp,parseApiTimestamp,()=>null,
);
const stage = {stage:'actionables',status:'completed',started_at:'2026-01-01T00:00:01Z',completed_at:'2026-01-01T00:00:00Z',provider_count:0,completed_provider_count:0,failed_provider_count:0,estimated_cost:0};
const render = changes=>renderToStaticMarkup(jsxRuntime.jsx(StageSummary,{stage:{...stage,...changes}}));

test('actual historical StageSummary visibly flags the negative one-second fixture without rewriting timestamps',()=>{
  const before=JSON.stringify(stage),html=render({});
  assert.match(html,/role="note"/);
  assert.match(html,/Invalid interval: recorded finish is before recorded start/);
  assert.ok(html.includes(formatApiTimestamp(stage.started_at)));
  assert.ok(html.includes(formatApiTimestamp(stage.completed_at)));
  assert.equal(JSON.stringify(stage),before);
});
test('timeline compares normalized instants including offsets and subsecond precision',()=>{
  assert.match(render({started_at:'2026-01-01 00:00:00.900',completed_at:'2026-01-01T05:30:00.800+05:30'}),/Invalid interval/);
  assert.doesNotMatch(render({started_at:'2026-01-01 00:00:00',completed_at:'2026-01-01T05:30:00+05:30'}),/Invalid interval/);
});
test('missing, invalid, active and ordinary positive intervals do not invent an ordering warning',()=>{
  for(const changes of [{started_at:null},{completed_at:null},{started_at:'invalid'},{completed_at:'invalid'},{status:'processing',completed_at:null},{completed_at:'2026-01-01T00:00:02Z'}])assert.doesNotMatch(render(changes),/Invalid interval/);
});
test('warning coexists with saved failure and partial warnings',()=>{
  const html=render({status:'failed',error_message:'Synthetic failure',summary:{partial_notice:'Synthetic partial notice'}});
  for(const text of ['Invalid interval','Synthetic failure','Synthetic partial notice'])assert.ok(html.includes(text));
});
test('actual timeline markup exposes warning in browser accessibility text and narrow layout',{skip:!process.env.A617_BROWSER},async()=>{
  const {chromium}=await import('playwright');
  const {default:postcss}=await import('postcss');
  const {default:tailwind}=await import('@tailwindcss/postcss');
  const frontend=new URL('../',import.meta.url).pathname;
  const css=(await postcss([tailwind({base:frontend})]).process('@import "tailwindcss";',{from:frontend+'app/globals.css'})).css;
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  try {
    const page=await browser.newPage();
    const external=[];await page.route('**/*',route=>{external.push(route.request().url());return route.abort();});
    for(const width of [1180,390]){
      await page.setViewportSize({width,height:757});
      await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><main style="padding:16px">'+render({})+'</main>');
      const warning=page.getByRole('note');assert.equal(await warning.isVisible(),true);
      assert.match(await page.locator('main').ariaSnapshot(),/Invalid interval: recorded finish is before recorded start/);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.screenshot({path:'/tmp/a617-timeline-'+width+'.png'});
    }
    assert.deepEqual(external,[]);
  }finally{await browser.close();}
});
