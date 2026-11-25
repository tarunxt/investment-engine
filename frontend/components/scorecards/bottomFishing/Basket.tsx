"use client";
import {createPortal} from "react-dom";
import {X} from "lucide-react";
import {useReviewDialog} from "@/hooks/useReviewDialog";
import {BasketResizeHandles} from "@/components/BasketResizeHandles";
import {Decisions} from "./StageOutput";
import {date, type Output} from "./model";

export function Basket({output,owner,onClose}:{output:Output;owner:number;onClose:()=>void}) {
  const dialog=useReviewDialog<HTMLDivElement>(true,onClose);
  return createPortal(<div className="basket-review-backdrop" onClick={onClose}>
    <div {...dialog} role="dialog" aria-modal="true" aria-label="Bottom Fishing Final Basket" className="basket-review-panel" onClick={e=>e.stopPropagation()}>
      <BasketResizeHandles panelRef={dialog.ref} owner={owner}/>
      <div className="basket-review-layout"><header className="flex items-start justify-between gap-4 border-b border-slate-200 p-5">
        <div><p className="text-[11px] font-semibold uppercase tracking-[0.35em] text-slate-400">Bottom Fishing · {output.mode}</p>
          <h3 className="mt-2 text-xl font-bold text-slate-950">Bottom Fishing Final Basket</h3>
          {output.finished_at && <p className="mt-2 text-xs font-semibold text-slate-600">Run #{output.request_id} · Saved {date(output.finished_at)} IST</p>}</div>
        <button onClick={onClose} aria-label="Close Bottom Fishing basket preview" className="rounded-full border border-slate-200 p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><X className="size-5"/></button>
      </header><div className="basket-review-content"><div className="pt-4"><Decisions output={output}/></div></div></div>
    </div></div>,document.body);
}
