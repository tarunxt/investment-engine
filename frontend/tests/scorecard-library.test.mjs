import assert from "node:assert/strict";
import {createServer} from "node:http";
import {existsSync} from "node:fs";
import {build} from "esbuild";
import {chromium} from "playwright";

const frontend = new URL("../",import.meta.url).pathname;
const mocks = {
  "next/link": 'import React from "react"; export default function Link(props){return <a {...props}/>;}',
  "next/navigation": 'export const useRouter=()=>({replace:path=>location.assign(path)});',
  "@/hooks/useAuth": 'export const useAuth=()=>({user:{id:7}});',
  "@/services/api": `export class APIError extends Error {}; export const apiService={
    get:async path=> path.endsWith("/board") ? JSON.parse(sessionStorage.board) : {id:"technical",name:"Technical",summary:"Price evidence",inputs:"OHLCV",prompt:"Assess the price",columns:["Listing","Score /100"]},
    getProviders:async()=>[{configured:true,name:"fixture",models:["offline"]}],
    post:async (path,change)=>{const b=JSON.parse(sessionStorage.board);b.weights=change.weights;b.version++;
      if(change.add)b.enabled.push(change.add);if(change.definition)b.custom.push(change.definition);
      sessionStorage.board=JSON.stringify(b);return b;}
  };`,
};
const bundle=await build({absWorkingDir:frontend,stdin:{contents:`
  import React from "react";import {createRoot} from "react-dom/client";
  import {ScorecardLibrary} from "@/components/scorecards/ScorecardLibrary";
  import {setWorkflowOwner} from "@/lib/workflowOwnerLifetime";
  setWorkflowOwner(7);
  const catalog=["rebalance","technical","threats","pairwise"].map(id=>({id,name:id[0].toUpperCase()+id.slice(1),summary:"Research methodology"}));
  sessionStorage.board??=JSON.stringify({catalog,version:1,enabled:["technical"],weights:{technical:100},custom:[]});
  const screen=location.pathname.split("scorecards/library")[1]?.slice(1)||"explore";
  createRoot(document.getElementById("root")).render(<ScorecardLibrary screen={screen}/>);
  `,resolveDir:frontend,loader:"tsx"},define:{"process.env":"{}"},jsx:"automatic",bundle:true,write:false,plugins:[{
  name:"offline-ports",setup(b){
    b.onResolve({filter:/^(next\/(link|navigation)|@\/(services\/api|hooks\/useAuth))$/},args=>({path:args.path,namespace:"fixture"}));
    b.onLoad({filter:/.*/,namespace:"fixture"},args=>({contents:mocks[args.path],loader:"tsx",resolveDir:frontend}));
  }}]});
const server=createServer((req,res)=>{
  if(req.url==="/bundle.js"){res.setHeader("content-type","application/javascript");res.end(bundle.outputFiles[0].contents);}
  else res.end('<!doctype html><div id="root"></div><script src="/bundle.js"></script>');
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
let browser;
try {
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||(existsSync("/usr/bin/chromium")?"/usr/bin/chromium":undefined),args:["--no-sandbox"]});
  const page=await browser.newPage();
  page.on("pageerror",error=>console.error(error.message));
  const root="http://127.0.0.1:"+server.address().port+"/console/zerodha/scorecards/library";
  await page.goto(root);
  await page.getByRole("heading",{name:"Explore Scorecards"}).waitFor();
  assert.equal(await page.locator("article").count(),4);
  const add=page.locator("article").filter({has:page.getByRole("link",{name:"Threats",exact:true})}).getByRole("button",{name:"Add Scorecard"});
  await add.click();
  assert.deepEqual(await page.getByRole("spinbutton").evaluateAll(ns=>ns.map(n=>n.value)),["100","0"]);
  await page.getByRole("button",{name:"Increase Threats weight"}).click();
  assert.equal(await page.getByRole("button",{name:"Add to Stage 3"}).isEnabled(),false);
  await page.getByRole("button",{name:"Decrease Technical weight"}).click();
  await page.getByRole("button",{name:"Cancel"}).click();
  assert.equal(await add.count(),1);
  await add.click();
  await page.getByRole("spinbutton",{name:/Technical/}).fill("90");
  await page.getByRole("spinbutton",{name:/Threats/}).fill("10");
  await page.getByRole("button",{name:"Add to Stage 3"}).click();
  await page.getByText("Threats added to Stage 3.",{exact:false}).waitFor();
  await page.reload();
  await page.getByRole("heading",{name:"Explore Scorecards"}).waitFor();
  assert.equal(await page.getByText("Scorecard added",{exact:true}).count(),2);
  await page.getByRole("link",{name:"Technical",exact:true}).click();
  await page.getByRole("heading",{name:"Inputs"}).waitFor();
  await page.getByRole("heading",{name:"Prompt"}).waitFor();
  await page.getByRole("columnheader",{name:"Score /100"}).waitFor();
  await page.getByRole("link",{name:"Create New Scorecard"}).click();
  await page.getByLabel("Name",{exact:true}).fill("Liquidity check");
  await page.getByLabel("Model",{exact:true}).selectOption("0");
  await page.getByLabel("Short description").fill("Assess liquidity.");
  await page.getByLabel("How should").fill("Use the frozen listing and price.");
  await page.getByLabel("Prompt",{exact:true}).fill("Give a liquidity score using available evidence.");
  await page.getByRole("button",{name:"Assign Weightages"}).click();
  assert.deepEqual(await page.getByRole("spinbutton").evaluateAll(ns=>ns.map(n=>n.value)),["90","10","0"]);
  await page.getByRole("spinbutton",{name:"Technical"}).fill("65.25");
  await page.getByRole("spinbutton",{name:/Liquidity check/}).fill("24.75");
  await page.getByRole("button",{name:"Add to Stage 3"}).click();
  await page.getByRole("heading",{name:"Liquidity check"}).waitFor();
  await page.getByRole("columnheader",{name:"Rationale"}).waitFor();
  assert.equal(await page.getByText("Scorecard added",{exact:true}).count(),1);
  console.log("PASS Explore, methodology, create, account weights, cancellation, total validation and reload.");
} finally {
  await browser?.close();
  server.close();
}
