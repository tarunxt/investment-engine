"use client";
import { draftDirection, stepDraftUnits } from '@/lib/basketEditableDraft';
import type { ReactNode } from 'react';
export function BasketDraftUnits({symbol, action, units, onChange, fractional = false, children}: {symbol:string;action:string|null;units:number|null;fractional?:boolean;onChange:(value:number)=>void;children:ReactNode}) {
  const side=draftDirection(action);
  const adjust = (delta: number) => {
    if (!fractional) return onChange(stepDraftUnits(units, delta));
    if (units === null) return;
    const value = (Math.round(units * 100) + delta) / 100;
    onChange(side === 'SELL' ? Math.min(0, value) : Math.max(0, value));
  };
  const locked = fractional && (!side || units === null);
  return <div data-testid={`units-${symbol}`} className={`inline-flex items-center overflow-hidden rounded-full border text-sm font-bold ${side==='SELL'?'border-red-200 bg-red-100 text-red-700':side==='BUY'?'border-emerald-200 bg-emerald-100 text-emerald-700':'border-slate-200 bg-slate-100 text-slate-700'}`}>
    <button type="button" aria-label={`Decrease ${symbol} draft Units`} disabled={locked || units===null || (fractional ? side !== "SELL" && units <= 0 : units <= 0)} className="px-3 py-2 hover:brightness-90 focus-visible:ring-2" onClick={()=>adjust(-1)}>−</button>
    {children}
    <button type="button" aria-label={`Increase ${symbol} draft Units`} disabled={locked || units===Number.MAX_SAFE_INTEGER || (fractional && side === "SELL" && units === 0)} className="px-3 py-2 hover:brightness-90 focus-visible:ring-2" onClick={()=>adjust(1)}>+</button>
  </div>;
}
