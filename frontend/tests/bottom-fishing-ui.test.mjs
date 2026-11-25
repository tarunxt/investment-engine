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
  "@/services/api": `export const apiService={
 get:async()=>({version:0,settings:{inputs:["bottom"],capital:100000,weights:{bounce:20,proximity:15,strength:15,recovery:10,roce:12,sales:10,profit:10,leverage:8}},state:{rows:[],positions:{}}}),
 post:async (path,v)=>({version:1,settings:v,state:{}})};`,
};
const bundle=await build({absWorkingDir:frontend,stdin:{contents:`
 import React from "react";import {createRoot} from "react-dom/client";
 import Page from "@/app/console/zerodha/bottom-fishing/page";
 import {BottomFishingBoard} from "@/components/scorecards/BottomFishingBoard";
 import {setWorkflowOwner} from "@/lib/workflowOwnerLifetime";
 setWorkflowOwner(7);
 createRoot(document.getElementById("root")).render(location.pathname.includes("bottom-fishing")?<Page/>:<BottomFishingBoard/>);
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
  await page.getByRole("button",{name:"Bottom Fishing Scorecard actions"}).click();
  await page.getByRole("menuitem",{name:"Inputs and weights"}).click();
  await page.getByRole("button",{name:"Inputs and weights"}).click();
  const input=page.getByRole("checkbox",{name:"Bottom Fishing Screen"});
  assert.equal(await input.isChecked(),true);
  assert.equal(await page.getByRole("checkbox").count(),1);
  await input.uncheck();
  await page.getByRole("button",{name:"Save",exact:true}).click();
  await page.getByText(/fresh entries paused/).waitFor();
  console.log("PASS four independent stages, scorecard menu, isolated sources and paper settings");
} finally {
  await browser?.close();
  server.close();
}
