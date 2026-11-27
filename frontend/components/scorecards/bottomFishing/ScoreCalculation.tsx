import {useRef} from "react";
import {labels, type Row, type Output} from "./model";

const formulas:Record<string,string> = {
  bounce:"Rebound above support ÷ range",
  proximity:"1 − (discovery price − support) ÷ (0.15 × range)",
  strength:"0.5 + (stock return − NIFTYBEES return) ÷ 0.04",
  recovery:"(latest close − discovery price) ÷ (0.25 × range)",
  roce:"ROCE (%) ÷ 25",
  sales:"Quarterly sales growth YoY (%) ÷ 25",
  profit:"Quarterly profit growth YoY (%) ÷ 25",
  leverage:"1 − debt/equity ÷ 2",
};
const exact = (v:number)=>v.toLocaleString("en-IN",{maximumFractionDigits:4});

export function ScoreCalculation({row,output}:{row:Row;output:Output}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const points=row.points??{};
  const entries=Object.entries(labels);
  const missing=entries.filter(([key])=>points[key]==null);
  const terms=entries.filter(([key])=>points[key]!=null).map(([key])=>points[key]);
  return <>
    <button type="button" className="text-indigo-700 underline underline-offset-2"
      aria-label={`Score calculation for ${row.symbol}`} onClick={()=>dialog.current?.showModal()}>
      {row.score==null?"Incomplete":row.score.toFixed(2)}
    </button>
    <dialog ref={dialog} className="m-auto max-h-[85vh] w-[min(42rem,94vw)] overflow-auto rounded-xl border border-slate-200 p-5 shadow-lg backdrop:bg-slate-900/40" aria-label={`Score calculation for ${row.symbol}`}>
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold">{row.symbol} · Score calculation</h2>
        <button type="button" className="text-indigo-700" onClick={()=>dialog.current?.close()}>Close</button>
      </div>
      <p>Each factor is limited to 0–1, multiplied by its saved weight and rounded to four decimals. The eight contributions are added and rounded to two decimals. Range means range high minus support. Returns in the relative-strength formula are decimals.</p>
      <table className="my-3 w-full text-left text-sm"><thead><tr><th>Component</th><th>Factor formula</th><th>Weight</th><th>Points</th></tr></thead>
        <tbody>{entries.map(([key,label])=><tr key={key} className="border-t"><th className="py-2">{label}</th><td>{formulas[key]}</td><td>{output.settings?.weights?.[key]??"—"}</td><td>{points[key]==null?"Missing":exact(points[key])}</td></tr>)}</tbody></table>
      {row.score!=null && !missing.length && <strong>{terms.map(exact).join(" + ")} ≈ {row.score.toFixed(2)} / 100</strong>}
      {row.score!=null && missing.length>0 && <p>Saved total {row.score.toFixed(2)} / 100. Some component details are unavailable in this record.</p>}
      {row.score==null && <p>Incomplete · {row.reason}. {terms.length>0 && <>Available subtotal {exact(terms.reduce((a,b)=>a+b,0))} points.</>}</p>}
    </dialog>
  </>;
}
