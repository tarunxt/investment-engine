#!/usr/bin/env node
// A6-16: actual history component, synthetic data, blocked external requests.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const require = createRequire(import.meta.url);
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = process.env.OUTPUT_PROVENANCE_EVIDENCE_DIR || "/tmp/audit6-output-provenance";
await mkdir(out,{recursive:true});
const evidence=[];
const temp = await mkdtemp(path.join(os.tmpdir(), "a6-16-ui-"));
let browser, server;
try {
  await writeFile(path.join(temp, "entry.tsx"), `import React from 'react';import {createRoot} from 'react-dom/client';import {AutoRebalanceHistoryDetailClient,AutoRebalanceHistoryListClient} from '${frontend}/app/console/auto-rebalance-runs/_components/AutoRebalanceHistoryClient';const portfolio=location.search.includes('us')?'indmoneyUs':'zerodha';createRoot(document.getElementById('root')).render(location.search.includes('lifecycle-list')?<AutoRebalanceHistoryListClient portfolio={portfolio}/>:<AutoRebalanceHistoryDetailClient portfolio={portfolio} sequence={44}/>);`);
  await writeFile(path.join(temp, "link.tsx"), `import React from 'react';export default function Link({children,...props}){return <a {...props}>{children}</a>}`);
  await writeFile(path.join(temp, "api.ts"), `let calls=0;const stamp='2026-10-10T01:00:00Z';window.__apiReads=[];const lifecycle=()=>({portfolio:'india',sequence:44,label:'Synthetic running workflow',status:'running',created_at:stamp,completed_at:null,current_stage:'threats',total_estimated_cost:.01,stages:[{stage:'threats',status:'completed',started_at:stamp,completed_at:'2026-10-10T01:01:00Z',provider_count:1,completed_provider_count:1,partial_provider_count:0,failed_provider_count:0,estimated_cost:.01,summary:{}}],runs:[],standalone_jobs:[{id:91,provider:'synthetic',model:'synthetic-fixture',status:'completed',prompt:'Synthetic Threats prompt',response:'Synthetic completed Threats output; overall lifecycle remains as saved.',created_at:stamp,updated_at:stamp}]});export const apiService={getAutoRebalanceHistory:async()=>{window.__apiReads.push('getAutoRebalanceHistory');return {items:[lifecycle()]};},getAutoRebalanceHistoryDetail:async()=>{window.__apiReads.push('getAutoRebalanceHistoryDetail');if(location.search.includes('lifecycle'))return lifecycle();
    calls++;if(location.search.includes('loading'))return new Promise(()=>{});if(location.search.includes('failed')&&(!location.search.includes('cached')||calls>1))throw Error('Synthetic read failure');
    return {label:'Synthetic saved workflow',status:'partial',created_at:stamp,completed_at:stamp,current_stage:'swing',total_estimated_cost:.01,stages:[],runs:[],standalone_jobs:location.search.includes('empty')?[]:[{id:91,provider:'deepseek',model:'deepseek-v4-flash',status:'partial',prompt:'Synthetic prompt',response:'Model: Claude Sonnet 4.5 (Anthropic)\\nSource date: 2026-10-08\\nSynthetic value: 123.45',error_message:'Synthetic partial warning',created_at:stamp,updated_at:stamp,runtime_metadata_json:{synthetic:'long_'.repeat(80)},output_provenance:location.search.includes('unknown')?null:{source:'api_usage_attempt_events',identities:[{provider:'deepseek',model:'deepseek-v4-flash'}],observed_from:stamp,observed_to:stamp}}]};}}`);
  await writeFile(path.join(temp, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=function(s){return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020},fileName:this.resourcePath}).outputText}`);
  const webpack = require("next/dist/compiled/webpack/webpack").webpack;
  await new Promise((resolve, reject) => webpack({ mode: "development", devtool: false,
    entry: path.join(temp, "entry.tsx"), output: { path: temp, filename: "bundle.js" },
    resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(frontend, "node_modules"), "node_modules"],
      alias: { "next/link$": path.join(temp, "link.tsx"), "@/services/api$": path.join(temp, "api.ts"), "@": frontend } },
    module: { rules: [{ test: /\.tsx?$/, use: path.join(temp, "loader.cjs") }] },
    plugins: [new webpack.DefinePlugin({ "process.env": JSON.stringify({ NODE_ENV: "development" }) })],
  }, (error, stats) => error ? reject(error) : stats.hasErrors() ? reject(Error(stats.toString({ all: false, errors: true }))) : resolve()));
  const css = (await postcss([tailwind({ base: frontend })]).process(await readFile(path.join(frontend, "app/globals.css"), "utf8"), { from: path.join(frontend, "app/globals.css") })).css;
  const bundle = await readFile(path.join(temp, "bundle.js"));
  server = createServer((req, res) => {
    if (req.url === "/bundle.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle); }
    else { res.setHeader("Content-Type", "text/html"); res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/bundle.js"></script>`); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  const errors = [], external = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.request().url().startsWith(base) && route.request().method()==="GET" && !new URL(route.request().url()).pathname.startsWith("/api/") ? route.continue() : (external.push(route.request().url()), route.abort()));
  for (const width of [1180, 390]) {
    await page.setViewportSize({ width, height: 800 });
    for (const market of ["india", "us"]) {
      await page.goto(`${base}/?${market}`);
      await page.getByText(/Attribution conflict:/).waitFor();
      assert.ok(await page.getByText(/Provider-response telemetry:/).isVisible());
      const prompt = page.locator("summary", { hasText: "Prompt and response" });
      await prompt.focus(); await page.keyboard.press("Enter");
      await page.getByText(/Source date: 2026-10-08/).waitFor({ state: "visible" });
      const metadata = page.locator("summary", { hasText: "Runtime metadata" });
      await metadata.focus(); await page.keyboard.press("Space");
      assert.equal(await metadata.evaluate(el => el.parentElement.open), true);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
      await prompt.focus(); await page.keyboard.press("Enter");
      assert.equal(await prompt.evaluate(el => el.parentElement.open), false);
      evidence.push({finding:"A6-16",width,market,state:"attribution-conflict",reads:await page.evaluate(()=>window.__apiReads)});
    }
    for (const state of ["loading", "failed", "empty", "unknown", "cached-failed"]) {
      await page.goto(`${base}/?${state}`);
      if (state === "loading") await page.getByText("Loading run detail…").waitFor();
      if (state === "failed") await page.getByText("Synthetic read failure").waitFor();
      if (state === "empty") await page.getByText("No LLM job was created for this run yet.").waitFor();
      if (state === "unknown") await page.getByText(/Execution identity unavailable:/).waitFor();
      if (state === "cached-failed") {
        await page.getByText(/Attribution conflict:/).waitFor();
        await page.getByRole("button", { name: "Refresh" }).click();
        await page.getByText("Synthetic read failure").waitFor();
        assert.ok(await page.getByText(/Attribution conflict:/).isVisible());
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
      evidence.push({finding:"A6-16",width,state,reads:await page.evaluate(()=>window.__apiReads)});
    }
    // A6-18: one completed component cannot establish overall completion.
    for(const market of ["india","us"]){
      await page.goto(`${base}/?lifecycle-list&${market}`);
      const card=page.getByRole("link").filter({has:page.getByRole("heading",{name:"Synthetic running workflow",exact:true})});
      await card.waitFor();
      await page.getByText(/Saved statuses and stages do not verify current worker activity/).waitFor();
      await page.getByText(/Component completion does not establish that the full run finished/).waitFor();
      await card.getByText("Last recorded stage",{exact:true}).waitFor();
      await card.getByText("Not recorded",{exact:true}).waitFor();
      await card.getByText(/Saved status\s+running/).waitFor();
      assert.equal(await card.getByText("completed",{exact:true}).count(),1);
      assert.doesNotMatch(await page.locator("body").innerText(),/In progress|Current stage/);
      await card.focus();assert.equal(await card.evaluate(el=>el===document.activeElement),true);
      assert.ok((await card.getAttribute("href")).endsWith("/44"));
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth));
      await page.screenshot({path:path.join(out,`a6-18-${width}-${market}-list.png`),fullPage:true});
      evidence.push({finding:"A6-18",width,market,surface:"list",overall:"running",component:"completed",finished:"Not recorded",reads:await page.evaluate(()=>window.__apiReads)});
      await page.goto(`${base}/?lifecycle-detail&${market}`);
      await page.getByRole("heading",{name:"Synthetic running workflow",exact:true}).waitFor();
      await page.getByText(/Saved statuses do not verify current worker activity/).waitFor();
      const summary=page.getByText("Run summary",{exact:true}).locator("xpath=../../..");
      await summary.getByText(/Saved status\s+running/).waitFor();
      await summary.getByText("Last recorded stage: Threats Scan",{exact:true}).waitFor();
      await summary.getByText("Finished: Not available",{exact:true}).waitFor();
      assert.equal(await summary.locator("svg.lucide-clock-3").count(),1);
      assert.equal(await summary.locator('svg[class*="check"]').count(),0);
      assert.doesNotMatch(await page.locator("body").innerText(),/In progress|Current stage/);
      const disclosure=page.locator("summary",{hasText:"Prompt and response"});await disclosure.focus();await page.keyboard.press("Enter");
      await page.getByText("Synthetic completed Threats output; overall lifecycle remains as saved.",{exact:true}).waitFor({state:"visible"});
      await disclosure.focus();await page.keyboard.press("Enter");assert.equal(await disclosure.evaluate(el=>el.parentElement.open),false);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth));
      await page.screenshot({path:path.join(out,`a6-18-${width}-${market}-detail.png`),fullPage:true});
      evidence.push({finding:"A6-18",width,market,surface:"detail",overall:"running",component:"completed",finished:"Not available",reads:await page.evaluate(()=>window.__apiReads)});
    }
  }
  assert.equal(evidence.filter(item=>item.finding==="A6-16").length,14);
  assert.equal(evidence.filter(item=>item.finding==="A6-18").length,8);
  for(const item of evidence)assert.ok(item.reads.every(name=>["getAutoRebalanceHistory","getAutoRebalanceHistoryDetail"].includes(name)));
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await writeFile(path.join(out,"result.json"),JSON.stringify({timestamp:new Date().toISOString(),result:"PASS",evidence,errors,external},null,2));
  console.log("A6-16/A6-18 offline UI passed: saved running lifecycle vs completed Threats; list/detail; missing completion labels;  both markets; 1180/390px; native disclosure keyboard; loading/failure/empty/unknown/retained history; no external requests.");
} finally {
  await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve());
  await rm(temp, { recursive: true, force: true });
}
