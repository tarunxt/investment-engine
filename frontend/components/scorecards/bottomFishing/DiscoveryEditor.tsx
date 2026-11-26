import type {Discovery} from "./model";

export const filterKeys=["universe","liquidity","touches","rebound","proximity"] as const;
const descriptions={
  universe:["Universe","Listing identity. Each membership or identity field is 1 when confirmed and 0 when false.","Nifty 50 member, Nifty 100 member, Nifty 200 member, Nifty 500 member, NSE equity, ISIN match"],
  liquidity:["Liquidity","Turnover is daily close × volume, in rupees. ₹1 crore is 10,000,000.","Median turnover, Mean turnover, Median volume, L, H, R"],
  touches:["Support touches","Test each completed session, then require the selected count and spacing.","Daily low, Daily high, Daily close, L, H, R"],
  rebound:["Rebound","Test the highest high strictly between a pair of sufficiently spaced touches.","Between touches high, L, H, R"],
  proximity:["Discovery price","Test the latest completed five-minute close.","Close, L, H, R"],
};
export const defaultDiscovery:Discovery={lookback:20,min_touches:2,touch_gap:5,minimum:5,formulas:{
  universe:"Nifty 500 member = 1 AND NSE equity = 1 AND ISIN match = 1",
  liquidity:"Median turnover >= 10000000", touches:"Daily low <= L + 0.10 * R",
  rebound:"Between touches high >= L + 0.40 * R",proximity:"Close >= L AND Close <= L + 0.15 * R",
}};
export const thresholdName=(n:number)=>n===5?"All five":"Any "+n;
const numeric=/(?<![a-z0-9_.])(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?![a-z0-9_.])/gi;
export function DiscoveryEditor({value,onChange,readOnly}:{value:Discovery;onChange:(v:Discovery)=>void;readOnly:boolean}){
  function period(key:"lookback"|"min_touches"|"touch_gap",label:string,min:number,max:number){
    return <label className="flex items-center gap-2">{label}<input aria-label={label} readOnly={readOnly} className="w-20 rounded border px-2 py-1" type="number" min={min} max={max} value={Number.isFinite(value[key])?value[key]:""} onChange={e=>onChange({...value,[key]:e.target.valueAsNumber})}/></label>;
  }
  return <section className="space-y-3 text-sm text-slate-700">
    <h3 className="font-semibold text-slate-950">Built-in discovery filters</h3>
    <p>L and H are the adjusted lowest low and highest high over the lookback. R = H − L.</p>
    {period("lookback","Lookback (completed NSE sessions)",5,120)}
    <ol className="space-y-3">{filterKeys.map((key,i)=>{
      const [name,description,fields]=descriptions[key];
      const formula=value.formulas[key];
      function updateFormula(text:string){onChange({...value,formulas:{...value.formulas,[key]:text}});}
      const indexNames=Array.from(formula.matchAll(/\bNifty\s+(50|100|200|500)\s+member\b/gi));
      const numbers=Array.from(formula.matchAll(numeric)).filter(m=>!/nifty\s+$/i.test(formula.slice(0,m.index)));
      return <li key={key} className="space-y-2 rounded-lg border p-3"><strong>{i+1}. {name}</strong><p>{description}</p>
        <label className="block">Formula<input aria-label={name+" formula"} readOnly={readOnly} value={formula} onChange={e=>updateFormula(e.target.value)} className="mt-1 block w-full rounded border px-2 py-2 font-mono text-sm"/></label>
        <p className="text-xs text-slate-600">Fields · {fields}</p>
        {key==="universe" && indexNames.map((m,j)=><label key={j} className="mr-3 inline-flex items-center gap-2">Index universe
          <select aria-label={"Index universe "+(j+1)} disabled={readOnly} value={Number(m[1])} className="rounded border px-2 py-1"
            onChange={e=>updateFormula(formula.slice(0,m.index)+"Nifty "+e.target.value+" member"+formula.slice(m.index!+m[0].length))}>{[50,100,200,500].map(n=><option key={n} value={n}>Nifty {n}</option>)}</select></label>)}
        <div className="flex flex-wrap gap-3">{numbers.map((m,j)=><label key={j}>Value {j+1} <input aria-label={name+" value "+(j+1)} className="w-32 rounded border px-2 py-1" type="number" step="any" readOnly={readOnly} value={m[0]} onChange={e=>{if(e.target.value!=="" && Number.isFinite(e.target.valueAsNumber))updateFormula(formula.slice(0,m.index)+e.target.value+formula.slice(m.index!+m[0].length));}}/></label>)}</div>
        {key==="touches"&&<div className="flex flex-wrap gap-4">{period("min_touches","Minimum touches",2,20)}{period("touch_gap","Minimum sessions apart",2,119)}</div>}
      </li>;
    })}</ol>
    {!readOnly&&<button type="button" className="text-indigo-700 underline" onClick={()=>onChange({...defaultDiscovery,minimum:value.minimum})}>Restore default formulas and lookback</button>}
  </section>;
}
