import type {ReactNode} from "react";
import {date, labels, num, type Output, type Stage} from "./model";

export function Table({headers,rows,empty}:{headers:string[]; rows:{key:string;cells:ReactNode[]}[];empty:string}) {
  return <div className="overflow-x-auto rounded-xl border border-slate-200"><table className="w-full text-left text-sm tabular-nums">
    <thead className="bg-slate-50 text-slate-600"><tr>{headers.map(h=><th scope="col" className="whitespace-nowrap px-3 py-2" key={h}>{h}</th>)}</tr></thead>
    <tbody>{rows.length ? rows.map(row=><tr key={row.key} className="border-t border-slate-200">{row.cells.map((v,i)=><td className="px-3 py-2" key={headers[i]}>{v}</td>)}</tr>)
    : <tr><td className="px-3 py-4 text-slate-500" colSpan={headers.length}>{empty}</td></tr>}</tbody></table></div>;
}

export function Decisions({output}:{output:Output}) {
  const {state} = output;
  const rows = state.rows ?? [];
  const entries = rows.filter(r=>r.qty);
  const amount = entries.reduce((sum,r)=>sum+(r.qty??0)*(r.price??0),0);
  return <div className="space-y-3">
    <p className="text-sm">{output.settings && <>Assigned capital ₹{num(output.settings.capital)} · </>}{entries.length} sized entries · Total ₹{num(amount)} · Market data {date(state.market_as_of ?? state.at)} IST</p>
    {state.status === "partial" && <p className="text-sm text-amber-800">Partial coverage. Decisions use only the available market data.</p>}
    {state.error && <p role="alert" className="text-sm text-red-700">{state.error}</p>}
    <Table headers={["Stock","Decision","Score /100","Price ₹","Breakout ₹","Max buy ₹","Qty","Amount ₹","Stop ₹","Target ₹","Net R/R"]}
      rows={rows.map(r=>({key:r.symbol,cells:[r.symbol,r.reason,num(r.score),num(r.price),num(r.breakout),num(r.max_buy),num(r.qty),num(r.qty && r.price ? r.qty*r.price : undefined),num(r.stop),num(r.target),num(r.rr)]}))}
      empty={state.status === "failed" ? "No final basket was produced by this run." : state.at ? "No entry qualified in this run." : "Awaiting the first completed run."}/>
  </div>;
}

export function StageOutput({stage,output}:{stage:Stage;output:Output}) {
  const {state} = output;
  const setups = Object.entries(state.setups??{});
  if (stage==="sync") return <><p>20 completed NSE sessions · {num(state.sync?.covered)} / {num(state.sync?.universe)} histories synced · {date(state.sync?.at)} IST</p>
    {output.settings && <p>Assigned paper capital ₹{num(output.settings.capital)}</p>}
    <Table headers={["Paper holding","Qty","Entry ₹","Stop ₹","Target ₹"]} empty="No open paper positions." rows={Object.entries(state.positions??{}).map(([k,p])=>({key:k,cells:[k,num(p.qty),num(p.price),num(p.stop),num(p.target)]}))}/></>;
  if (stage==="screen") return <><p>{setups.length} discovered · {num(state.scans?.at(-1)?.current_candles)} / {num(state.scans?.at(-1)?.patterns)} support patterns with a current candle</p>
    <Table headers={["Stock","Discovered (IST)","Discovery ₹","Support ₹","Range high ₹","Setup"]} empty="No setups recorded." rows={setups.map(([k,v])=>({key:k,cells:[k,date(v.discovered),num(v.discovery),num(v.low),num(v.high),v.invalid?"Support broken":"In range at discovery"]}))}/></>;
  if (stage==="score") return <Table headers={["Stock","Score /100",...Object.values(labels),"Decision"]} empty="No scored listings recorded."
    rows={(state.rows??[]).map(r=>({key:r.symbol,cells:[r.symbol,num(r.score),...Object.keys(labels).map(k=>num(r.points?.[k])),r.reason]}))}/>;
  return <><Decisions output={output}/>{!!state.closed?.length && <details><summary>Closed paper positions · Realised P&amp;L ₹{num(state.realized)}</summary>
    <Table headers={["Stock","Qty","Exit (IST)","Reason","P&L ₹"]} empty="No exits." rows={state.closed.map((p,i)=>({key:p.end+p.symbol+i,cells:[p.symbol,num(p.qty),date(p.end),p.reason,num(p.pnl)]}))}/></details>}</>;
}

export function StockFlow({output}:{output:Output}) {
  const s=output.state, rows=new Map((s.rows??[]).map(r=>[r.symbol,r]));
  const symbols=Array.from(new Set([...Object.keys(s.setups??{}),...rows.keys()]));
  return <><p>{num(s.sync?.covered)} histories synced · {symbols.length} discovered · {Array.from(rows.values()).filter(r=>r.score!=null).length} scored</p>
    <Table headers={["Stock","Screen (IST)","Score /100","Stage 4 decision","Qty"]} empty="No stocks have progressed through the screen." rows={symbols.map(k=>{
      const row=rows.get(k);return {key:k,cells:[k,date(s.setups?.[k]?.discovered),num(row?.score),row?.reason??"Outside selected scorecard inputs",num(row?.qty)]};
    })}/></>;
}
