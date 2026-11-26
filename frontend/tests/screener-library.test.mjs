import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { build } from "esbuild";
import { chromium } from "playwright";

const frontend = new URL("../", import.meta.url).pathname;
const mocks = {
  "next/link": 'export default function Link(props){return <a {...props}/>;}',
  "next/navigation": 'export const useRouter=()=>({push:path=>location.assign(path)});',
  "@/hooks/useAuth": 'export const useAuth=()=>({user:{id:7}});',
  "@/services/api": `const key="custom-"+"a".repeat(32);
    const initial={version:0, fields:["Current price"], assigned:{og:["swing"],bfs:["bottom"]},
      screeners:[{id:"swing",name:"Swing Scan",summary:"Research"},{id:"bottom",name:"Bottom Fishing Screen",summary:"Query"}]};
    const read=()=>JSON.parse(sessionStorage.board||JSON.stringify(initial));
    export const apiService={get:async path=>path.endsWith("/result")?JSON.parse(sessionStorage.result||"null"):read(),
      post:async(path,body)=>{
        if(path.endsWith("/run")) {sessionStorage.result=JSON.stringify({status:"partial",report:{total:1,unknown:2,universe_size:10,rows:[{symbol:"ONE",exchange:"NSE",name:"One Company"}]}});return {status:"queued"};}
        const board=read();if(body.version!==board.version)throw Error("stale update");
        if(body.definition)board.screeners.push({id:key,...body.definition});
        board.assigned[body.strategy].push(body.existing||key);board.version++;sessionStorage.board=JSON.stringify(board);return board;
      }};`,
};
const bundle = await build({absWorkingDir:frontend, stdin:{contents:`
 import {createRoot} from "react-dom/client";
 import {ScreenerLibrary} from "@/components/screeners/ScreenerLibrary";
 import {ScreenerLane} from "@/components/screeners/ScreenerLane";
 import {setWorkflowOwner} from "@/lib/workflowOwnerLifetime";
 setWorkflowOwner(7);
 const route="/console/zerodha/screener-library";
 const screen=location.pathname.slice(route.length+1)||"explore";
 const strategy=new URLSearchParams(location.search).get("strategy")||"og";
 createRoot(document.querySelector("main")).render(location.pathname.startsWith(route)
   ? <ScreenerLibrary screen={screen} strategy={strategy}/>
   : <><section aria-label="OG"><ScreenerLane strategy="og"/></section><section aria-label="BFS"><ScreenerLane strategy="bfs"/></section></>);
 `,resolveDir:frontend,loader:"tsx"}, define:{"process.env":"{}"},jsx:"automatic",bundle:true,write:false,plugins:[{
  name:"mock-api",setup(b) {
    b.onResolve({filter:/^(next\/(link|navigation)|@\/(services\/api|hooks\/useAuth))$/}, args=>({path:args.path,namespace:"fixture"}));
    b.onLoad({filter:/.*/,namespace:"fixture"}, args=>({contents:mocks[args.path],loader:"tsx",resolveDir:frontend}));
  }}]});
const server = createServer((req,res) => {
  if(req.url === "/bundle.js") { res.setHeader("content-type","application/javascript"); res.end(bundle.outputFiles[0].contents); }
  else res.end('<!doctype html><main></main><script src="/bundle.js"></script>');
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
let browser;
try {
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||(existsSync("/usr/bin/chromium")?"/usr/bin/chromium":undefined),args:["--no-sandbox"]});
  const page=await browser.newPage();
  await page.goto("http://127.0.0.1:"+server.address().port+"/console/zerodha");
  await page.getByRole("region",{name:"BFS"}).getByRole("link",{name:"Add Screener"}).click();
  await page.getByRole("heading",{name:"Swing Scan"}).waitFor();
  assert.equal(await page.getByLabel("Stage 2 board").inputValue(),"bfs");
  const swing=page.getByRole("article").filter({hasText:"Swing Scan"});
  await swing.getByRole("button",{name:"Add Screener"}).click();
  await swing.getByText("Added to Bottom Fishing").waitFor();
  await page.getByRole("link",{name:"Back to Bottom Fishing · Stage 2"}).click();
  await page.getByRole("region",{name:"BFS"}).getByRole("link",{name:/Swing Scan/}).waitFor();
  await page.getByRole("region",{name:"OG"}).getByRole("link",{name:"Add Screener"}).click();
  await page.getByRole("link",{name:"Create New Screener"}).click();
  await page.getByLabel("Screener name").fill("Liquid stocks");
  await page.getByLabel("Short description").fill("Price threshold");
  await page.getByLabel("Screening query").fill("Current price > 100");
  await page.getByRole("button",{name:"Save and add to OG Strategy"}).click();
  await page.getByRole("heading",{name:"Liquid stocks"}).waitFor();
  await page.getByRole("button",{name:"Run screener"}).click();
  await page.getByRole("cell",{name:"NSE:ONE"}).waitFor();
  await page.reload();
  await page.getByRole("cell",{name:"One Company"}).waitFor();
  await page.getByRole("link",{name:"Back to OG Strategy · Stage 2"}).click();
  await page.getByRole("region",{name:"OG"}).getByRole("link",{name:/Liquid stocks/}).waitFor();
  assert.equal(await page.getByRole("region",{name:"BFS"}).getByRole("link",{name:/Liquid stocks/}).count(),0);
  console.log("PASS both board entry points, built-ins, cross-assignment, custom creation, results and reload.");
} finally { await browser?.close(); server.close(); }
