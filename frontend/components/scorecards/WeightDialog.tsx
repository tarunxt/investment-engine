"use client";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {cardLabel, initialPercentages, type Board, type Intro} from "@/lib/scorecardBoard";

export function WeightDialog({board, addition, onCancel, onSave}: {
  board:Board; addition?:Intro; onCancel:()=>void; onSave:(weights:Record<string,number>)=>Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const [values,setValues] = useState(()=>initialPercentages(board, addition?.id));
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  useEffect(()=>{const d=dialog.current; d?.showModal(); return ()=>d?.close();},[]);
  const ids = [...board.enabled,...(addition?[addition.id]:[])];
  const valid = ids.every(id=>/^\d{1,3}(\.\d{1,2})?$/.test(values[id]) && Number(values[id])<=100);
  const points = ids.reduce((sum,id)=>sum+Math.round((Number(values[id])||0)*100),0);
  const adjust=(id:string, step:number)=>setValues(v=>({...v,[id]:String(Math.max(0,Math.min(100,Math.round(((Number(v[id])||0)+step)*100)/100)))}));
  return <dialog ref={dialog} onCancel={e=>{e.preventDefault();if(!busy)onCancel();}} aria-labelledby="allocation-title"
    className="m-auto max-h-[85dvh] w-[min(30rem,94vw)] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-xl backdrop:bg-slate-950/40">
    <h2 id="allocation-title" className="text-xl font-semibold">Assign Weightages</h2>
    <p className="mt-1 text-sm text-slate-600">Set each scorecard’s share of the final score. Use up to two decimal places.</p>
    <form onSubmit={async e=>{e.preventDefault();if(submitting.current||!valid||points!==10000)return;
      submitting.current=true;setBusy(true);setError("");
      try{await onSave(Object.fromEntries(ids.map(id=>[id,Number(values[id])])));}
      catch(err){setError(err instanceof Error?err.message:String(err));}
      finally{submitting.current=false;setBusy(false);}
    }}>
      <fieldset disabled={busy} className="my-4 divide-y">{ids.map(id=>{
        const name = addition?.id===id? addition.name:cardLabel(board,id);
        return <div key={id} className="flex flex-wrap items-center justify-between gap-2 py-3">
          <label htmlFor={"weight-"+id} className="min-w-0 break-words font-medium">{name} {addition?.id===id&&<small className="text-indigo-700">New</small>}</label>
          <div className="flex items-center gap-1">
            <button type="button" className="rounded border p-2" aria-label={"Decrease "+name+" weight"} onClick={()=>adjust(id,-1)}><ChevronLeft size={16}/></button>
            <input id={"weight-"+id} type="number" min="0" max="100" step="0.01" required value={values[id]??""} onChange={e=>setValues({...values,[id]:e.target.value})} className="w-20 rounded border p-2 text-center"/> %
            <button type="button" className="rounded border p-2" aria-label={"Increase "+name+" weight"} onClick={()=>adjust(id,1)}><ChevronRight size={16}/></button>
          </div></div>;
      })}</fieldset>
      <p aria-live="polite" className="flex justify-between border-t pt-3 font-semibold"><span>Total</span><span>{(points/100).toFixed(2)} / 100%</span></p>
      {points!==10000&&<p className="mt-1 text-sm text-amber-800">{points<10000?"Assign":"Remove"} {Math.abs(10000-points)/100}% to save.</p>}
      {error&&<p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      <div className="mt-5 flex justify-end gap-2"><button type="button" disabled={busy} onClick={onCancel} className="rounded-lg border px-3 py-2">Cancel</button>
      <button disabled={busy||!valid||points!==10000} className="rounded-lg bg-indigo-700 px-4 py-2 font-semibold text-white disabled:opacity-40">{busy?"Saving…":addition?"Add to Stage 3":"Save weights"}</button></div>
    </form>
  </dialog>;
}
