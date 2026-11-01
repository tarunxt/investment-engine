import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test, { before, after } from 'node:test';
import { chromium } from 'playwright';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

const require = createRequire(import.meta.url);
const { webpack } = require('next/dist/compiled/webpack/webpack');
const frontend = fileURLToPath(new URL('../', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'audit-read-states-'));
let browser;
let css;
before(async () => {
  writeFileSync(join(temp, 'loader.cjs'), `const ts = require(${JSON.stringify(require.resolve('typescript'))}); module.exports = source => ts.transpileModule(source, { compilerOptions: {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX} }).outputText;`);
  writeFileSync(join(temp, 'link.jsx'), `import React from 'react'; export default function Link({children,...props}) {return <a {...props}>{children}</a>}`);
  writeFileSync(join(temp, 'api.js'), `export const apiService = {
    async getBullpenRunAudits(params) {
      const f = window.fixture; f.calls.push(params);
      const fail = f.fail; const response = structuredClone(f.response); const delay = f.delay;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (fail) throw new Error('Synthetic history read failure');
      return {...response,page:params.page,limit:params.limit};
    },
    async getBullpenAutoLiveRuns() {if(window.fixture.failRuns) throw new Error('Synthetic run failure'); return window.fixture.runs || []},
    async materializeBullpenRunAudit() {throw new Error('Explicit materialization must not be called')}
  };`);
  writeFileSync(join(temp, 'entry.tsx'), `import React from 'react'; import {createRoot} from 'react-dom/client'; import {RunAuditListClient} from ${JSON.stringify(join(frontend,'app/console/bullpen-ai/analyse-runs/_components/RunAuditListClient.tsx'))}; createRoot(document.getElementById('app')).render(<RunAuditListClient/>);`);
  const compiler = webpack({mode:'development',devtool:false,context:frontend,entry:join(temp,'entry.tsx'),output:{path:temp,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.jsx','.js'],modules:[join(frontend,'node_modules'),'node_modules'],alias:{'@/services/api$':join(temp,'api.js'),'next/link$':join(temp,'link.jsx'),'@':frontend}},module:{rules:[{test:/\.(tsx?|jsx)$/,exclude:/node_modules/,use:join(temp,'loader.cjs')}]},plugins:[new webpack.DefinePlugin({'process.env':JSON.stringify({NODE_ENV:'development'})})]});
  await new Promise((resolve,reject)=>compiler.run((error,stats)=>compiler.close(()=>error||stats.hasErrors()?reject(error||new Error(stats.toString({all:false,errors:true}))):resolve())));
  css = (await postcss([tailwind()]).process('@import "tailwindcss";', {from:join(frontend,'app/globals.css')})).css;
  browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
});
after(async()=>{await browser?.close()});
const populated = {items:[{snapshot_id:1,run_id:'synthetic-run-alpha',run_status:'completed',audit_status:'native',lifecycle_status:'frozen',source_kind:'native',completeness_pct:100,started_at:'2026-01-01T00:00:00Z',stage1_status:'pass',stage2_status:'pass',stage3_status:'pass',scanned_candidate_count:0,candidate_rows_before_llm:0,llm_candidate_count:0,llm_succeeded_call_count:0,llm_attempted_call_count:0,qualified_candidate_count:0,ranked_count:0,final_selection_count:0,decisions_count:0,orders_planned:0,orders_submitted:0,orders_filled:0,findings_critical:0,findings_high:0,findings_medium:0,findings_low:0,findings_info:0,manual_deficiency_count:0,provider_failure_count:0,incomplete_data_count:0,snapshot_version:1}],total:21,total_pages:2};
async function open(overrides={}) {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  page.setDefaultTimeout(5000);
  page.on('pageerror', error=>console.error('fixture render error:',error.message));
  await page.route('**/*', route=>route.abort());
  await page.setContent('<main id="app"></main>');
  await page.evaluate(config=>{window.fixture={calls:[],fail:false,delay:0,response:{items:[],total:0,total_pages:0},...config}},overrides);
  await page.addStyleTag({content:css});
  await page.addScriptTag({path:join(temp,'bundle.js')});
  await page.getByRole('heading',{name:'Bullpen Runs Audit',exact:true}).waitFor();
  return page;
}
async function text(page){return page.locator('body').innerText()}
async function waitRead(page){await page.getByText('Page count unverified',{exact:true}).waitFor({state:'hidden'})}
function selectField(page,label){return page.locator('label').filter({has:page.getByText(label,{exact:true})}).locator('select')}
async function apply(page){await page.getByRole('button',{name:'Apply Filters',exact:true}).click()}
function noEmptyClaims(value){assert.doesNotMatch(value,/No .*snapshots (matched|returned|yet)|No Bullpen runs|No persisted audit snapshots on this page/)}

test('initial loading and failed read never imply empty history; keyboard retry recovers',async()=>{
  const page=await open({delay:150,fail:true});
  noEmptyClaims(await text(page));
  await page.getByRole('alert').waitFor();
  noEmptyClaims(await text(page));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  if(process.env.AUDIT_SCREENSHOT_DIR) await page.screenshot({path:join(process.env.AUDIT_SCREENSHOT_DIR,'failed-narrow.png'),fullPage:true});
  assert.equal(await page.getByRole('button',{name:'Next',exact:true}).isDisabled(),true);
  await page.evaluate(()=>{window.fixture.fail=false;window.fixture.delay=0});
  await page.getByRole('button',{name:'Retry history read'}).focus();
  await page.keyboard.press('Enter');
  await waitRead(page);
  assert.match(await text(page),/successful history read/);
  if(process.env.AUDIT_SCREENSHOT_DIR) await page.screenshot({path:join(process.env.AUDIT_SCREENSHOT_DIR,'empty-narrow.png'),fullPage:true});
  await page.close();
});

test('every filter option and page-size boundary distinguishes successful zero from failure',async()=>{
  const page=await open(); await waitRead(page);
  const labels=['Status','Trigger','Dry / Live','Stage Failure','Audit Status','Finding Severity','Feedback','Per Page'];
  const cases=[];
  for(const label of labels){for(const value of await selectField(page,label).locator('option').evaluateAll(options=>options.map(o=>o.value))){cases.push({label,value,select:true})}}
  cases.push({label:'Run ID',value:'synthetic-id'},{label:'From',value:'2026-01-01'},{label:'To',value:'2026-01-02'});
  for(const {label,value,select} of cases){
    await page.getByRole('button',{name:'Reset',exact:true}).click();
    await page.evaluate(()=>{window.fixture.fail=false});
    if(select) await selectField(page,label).selectOption(value); else await page.getByLabel(label,{exact:true}).fill(value);
    await apply(page); await waitRead(page);
    assert.match(await text(page),/No .*snapshots (matched|returned)/,`${label}=${value}`);
    await page.evaluate(()=>{window.fixture.fail=true});
    await apply(page); await page.getByRole('alert').waitFor();
    noEmptyClaims(await text(page));
    assert.equal(await page.getByRole('button',{name:'Previous',exact:true}).isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'Next',exact:true}).isDisabled(),true);
  }
  await page.close();
});

test('cached records keep provenance after filter/page failures and source partial failure',async()=>{
  const page=await open({response:populated,failRuns:true});await waitRead(page);
  await page.getByRole('link',{name:/synthetic-run-alpha/}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Previous',exact:true}).isDisabled(),true);
  await page.evaluate(()=>{window.fixture.fail=true});
  await page.getByRole('button',{name:'Next',exact:true}).click();await page.getByRole('alert').waitFor();
  assert.match(await text(page),/Last successful audit read:.*Page 1/);
  assert.match(await text(page),/synthetic-run-alpha/);
  noEmptyClaims(await text(page));
  await page.evaluate(()=>{window.fixture.fail=false;window.fixture.response={items:[],total:21,total_pages:2}});
  await page.getByRole('button',{name:'Retry history read'}).click(); await waitRead(page);
  assert.match(await text(page),/No persisted audit snapshots on this page/);
  assert.equal(await page.getByRole('button',{name:'Next',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'Previous',exact:true}).isDisabled(),false);
  await page.evaluate(()=>{window.fixture.response={items:[],total:0,total_pages:0}});
  await page.getByRole('button',{name:'Previous',exact:true}).click(); await waitRead(page);
  assert.match(await text(page),/successful history read/);
  await page.close();
});

test('interrupted requests cannot replace the latest filter result',async()=>{
  const page=await open({delay:250,response:populated});
  await page.evaluate(()=>{window.fixture.delay=0;window.fixture.response={items:[],total:0,total_pages:0}});
  await page.getByLabel('Run ID',{exact:true}).fill('other-synthetic-id'); await apply(page);await waitRead(page);
  await page.waitForTimeout(300);
  assert.doesNotMatch(await text(page),/synthetic-run-alpha/);
  assert.match(await text(page),/matched the current filters/);
  assert.equal(await page.evaluate(()=>window.fixture.calls.at(-1).runIdSearch),'other-synthetic-id');
  await page.close();
});

// Pagination totals belong to a successful request, including first/middle/last pages.
test('first, middle, and last pages preserve records on failed reads for each page size',async()=>{
  for(const limit of [10,20,50]){
    const page=await open({response:{...populated,total:limit*2+1,total_pages:3}});await waitRead(page);
    await selectField(page,'Per Page').selectOption(String(limit));await apply(page);await waitRead(page);
    for(const number of [1,2,3]){
      assert.match(await text(page),new RegExp(`Page ${number===1?1:number-1} of 3`));
      assert.equal(await page.getByRole('button',{name:'Previous',exact:true}).isDisabled(),number<=2);
      assert.equal(await page.getByRole('button',{name:'Next',exact:true}).isDisabled(),false);
      await page.evaluate(()=>{window.fixture.fail=true});
      if(number===1) await apply(page); else await page.getByRole('button',{name:'Next',exact:true}).click();
      await page.getByRole('alert').waitFor();
      noEmptyClaims(await text(page));
      assert.match(await text(page),/synthetic-run-alpha/);
      if(process.env.AUDIT_SCREENSHOT_DIR && limit===10 && number===1) await page.screenshot({path:join(process.env.AUDIT_SCREENSHOT_DIR,'cached-narrow.png'),fullPage:true});
      await page.evaluate(()=>{window.fixture.fail=false});await page.getByRole('button',{name:'Retry history read'}).click();await waitRead(page);
      assert.match(await text(page),new RegExp(`Page ${number} of 3`));
      assert.equal(await page.getByRole('button',{name:'Next',exact:true}).isDisabled(),number===3);
    }
    await page.close();
  }
});

test('opening a supplemental run cannot turn a verified history read into a history failure',async()=>{
  const page=await open({runs:[{id:'synthetic-supplemental-run',status:'completed',dry_run:true,started_at:'2026-01-01T00:00:00Z',decisions_count:0,orders_planned:0,orders_submitted:0}]});await waitRead(page);
  await page.getByRole('button',{name:/synthetic-supplemental-run/}).click();
  await page.getByRole('alert').waitFor();
  assert.match(await text(page),/Explicit materialization must not be called/);
  assert.match(await text(page),/successful history read/);
  assert.doesNotMatch(await text(page),/history unavailable|current filters and page are unverified/);
  await page.close();
});
