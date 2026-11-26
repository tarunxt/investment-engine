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
  "@/services/api": `const row={symbol:"NSE:TEST",score:82,price:100,qty:2,stop:96,target:111,rr:2.2,reason:"Proposed buy",sources:["bottom"]};
    const state={at:"2026-11-25T15:30:00+05:30",rows:[row,{...row,symbol:"NSE:WATCH",qty:undefined,score:67.57,price:222,target:235.3,reason:"Score below 70"},{...row,symbol:"NSE:MISSING",qty:undefined,score:undefined,price:undefined,target:undefined,reason:"Missing current closed candle"}],positions:{},setups:{"NSE:TEST":{discovered:"2026-11-25T15:30:00+05:30",discovery:99}}};
    const data={version:0,settings:{screen_query:"Current price > 10",latest_results:false,inputs:["bottom"],capital:100000,weights:{bounce:20,proximity:15,strength:15,recovery:10,roce:12,sales:10,profit:10,leverage:8}},state:{},review:{request_id:42,mode:"Manual review",state}};
    export const apiService={
      get:async path=>path.endsWith("/history")?{items:[{id:45,mode:"Manual review",scored:1,entries:1,candidates:1,status:"completed"}]}:path.endsWith("/history/45")?data.review:data,
      post:async (path,v)=>{if(path.endsWith("/run")){window.submits=(window.submits??0)+1;window.runVersion=v.version;data.manual={id:46,status:"queued"};return data.manual;}
        data.settings=v;data.version++;return {...data};}
    };`,
};
const bundle=await build({absWorkingDir:frontend,stdin:{contents:`
 import React from "react";import {createRoot} from "react-dom/client";
 import {StagePage} from "@/components/scorecards/bottomFishing/StagePage";
 import {BottomFishingBoard} from "@/components/scorecards/BottomFishingBoard";
 import {setWorkflowOwner} from "@/lib/workflowOwnerLifetime";
 setWorkflowOwner(7);
 createRoot(document.getElementById("root")).render(location.pathname.includes("bottom-fishing")?<StagePage stage={location.pathname.split("/").at(-1)} view={new URLSearchParams(location.search).get("view")} record={Number(new URLSearchParams(location.search).get("record"))}/>:<BottomFishingBoard/>);
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
  const root="http://127.0.0.1:"+server.address().port;
  await page.goto(root);
  await page.getByRole("heading",{name:"Bottom fishing",exact:true}).waitFor();
  assert.equal(await page.locator("article").count(),4);
  const run=page.getByRole("button",{name:"Run Bottom fishing"});
  await run.click();
  await page.getByText(/Queued for immediate analysis/).waitFor();
  assert.equal(await run.isDisabled(),true);
  assert.equal(await page.evaluate(()=>window.submits),1);
  await page.getByRole("button",{name:"View Final Basket"}).click();
  const basket=page.getByRole("dialog",{name:"Bottom Fishing Final Basket"});
  async function verifyChart(scope) {
    const link = scope.getByRole("link",{name:"NSE:TEST",exact:true});
    assert.equal(await link.getAttribute("href"),"https://www.tradingview.com/chart/?symbol=NSE%3ATEST");
    assert.equal(await link.getAttribute("target"),"_blank");
  }
  await verifyChart(basket);
  assert.equal(await basket.getByRole("columnheader",{name:"Stop ₹"}).count(),1);
  assert.equal(await basket.getByRole("columnheader",{name:"Amount ₹"}).count(),1);
  assert.equal(await basket.getByRole("button",{name:/place order/i}).count(),0);
  const decisionTable=basket.getByRole("table",{name:"Bottom Fishing basket decisions"});
  const priced=decisionTable.getByRole("row").filter({hasText:"NSE:WATCH"});
  const qty=priced.getByRole("textbox",{name:"NSE:WATCH preview Qty"});
  assert.equal(await qty.inputValue(),"0");
  await priced.getByRole("cell",{name:"₹0.00",exact:true}).waitFor();
  await priced.getByRole("cell",{name:"5.99%",exact:true}).waitFor();
  await priced.getByRole("button",{name:"Increase NSE:WATCH draft Units"}).click();
  await priced.getByRole("cell",{name:"₹222.00",exact:true}).waitFor();
  await qty.fill("10");
  await priced.getByRole("cell",{name:"₹2,220.00",exact:true}).waitFor();
  assert.equal(await basket.getByLabel("Preview basket amount").innerText(),"₹2,420.00");
  await priced.getByRole("button",{name:"Decrease NSE:WATCH draft Units"}).click();
  assert.equal(await qty.inputValue(),"9");
  await priced.getByText("Score below 70").waitFor();
  const missing=decisionTable.getByRole("row").filter({hasText:"NSE:MISSING"});
  await missing.getByRole("textbox").fill("1");
  assert.equal(await missing.getByRole("cell").nth(10).innerText(),"—");
  assert.equal(await basket.getByLabel("Preview basket amount").innerText(),"—");
  await basket.getByRole("button",{name:"Reset quantities"}).click();
  assert.equal(await qty.inputValue(),"0");
  assert.equal(await basket.getByLabel("Preview basket amount").innerText(),"₹200.00");
  assert.equal(await page.evaluate(()=>window.submits),1);

  await page.keyboard.press("Escape");
  await basket.waitFor({state:"hidden"});
  const titles=["Sync Kite portfolio","Bottom Fishing Screen","Bottom Fishing Scorecard","Bottom Fishing Actionables"];
  for(const title of titles){
    await page.getByRole("button",{name:title+" actions"}).click();
    const labels=await page.getByRole("menuitem").allTextContents();
    for(const label of ["Inputs","Saved output","Stock Flow","History","Open stage"])assert.ok(labels.includes(label));
    assert.equal(labels.includes("Weights"),title===titles[2]);
    await page.getByRole("menuitem",{name:"Saved output",exact:true}).click();
    await page.getByRole("dialog",{name:title+" · Saved output"}).waitFor();
    if(title!==titles[0]) await verifyChart(page.getByRole("dialog"));
    await page.keyboard.press("Escape");
  }
  await page.getByRole("button",{name:"Bottom Fishing Screen actions"}).click();
  await page.getByRole("menuitem",{name:"Inputs",exact:true}).click();
  assert.equal(await page.getByRole("dialog").getByRole("textbox",{name:"Query",exact:true}).inputValue(),"Current price > 10");
  await page.keyboard.press("Escape");
  const menu=page.getByRole("button",{name:"Bottom Fishing Scorecard actions"});
  await menu.click(); await page.getByRole("menuitem",{name:"Weights"}).click();
  await page.getByRole("spinbutton",{name:"Support bounce"}).waitFor(); await page.keyboard.press("Escape");
  await menu.click(); await page.getByRole("menuitem",{name:"Inputs",exact:true}).click();
  const input=page.getByRole("checkbox",{name:"Bottom Fishing Screen"});
  assert.equal(await input.isChecked(),true);
  await input.uncheck();
  await page.getByRole("button",{name:"Save",exact:true}).click();
  await page.getByText("Settings saved.").waitFor(); await page.keyboard.press("Escape");
  await menu.click(); await page.getByRole("menuitem",{name:"Stock Flow"}).click();
  await page.getByRole("dialog").getByText("Proposed buy").waitFor(); await page.keyboard.press("Escape");
  await menu.click(); await page.getByRole("menuitem",{name:"Scorecard history"}).click();
  await page.getByRole("link",{name:/#45/}).click();
  await page.getByRole("heading",{name:"Saved run #45"}).waitFor();
  await page.getByRole("cell",{name:"82",exact:true}).waitFor();
  await verifyChart(page);
  for(const stage of ["screen","score","actionables"]){
    await page.goto(root+"/console/zerodha/bottom-fishing/"+stage+"?view=stock-flow");
    await verifyChart(page);
  }
  await page.goto(root+"/console/zerodha/bottom-fishing/screen?view=inputs");
  const query=page.getByRole("textbox",{name:"Query",exact:true});
  assert.equal(await query.inputValue(),"Current price > 10");
  assert.equal(await page.getByRole("link",{name:"Inputs",exact:true}).getAttribute("aria-current"),"page");
  await query.fill("Current price < 100\nAND MACD > MACD Previous Day");
  await page.getByRole("checkbox",{name:/Only companies with/}).check();
  await page.getByRole("button",{name:"Save query",exact:true}).click();
  await page.getByText("Query saved.",{exact:true}).waitFor();
  await page.getByRole("button",{name:"Run this query",exact:true}).click();
  await page.getByText("Query submitted for a manual review.",{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.runVersion),1);
  console.log("PASS editable Stage 2 Inputs, checkbox, versioned save and manual run");
  console.log("PASS immediate analysis request, review basket, four stage menus, settings, saved outputs, stock flow and frozen scorecard history");
} finally {
  await browser?.close();
  server.close();
}
