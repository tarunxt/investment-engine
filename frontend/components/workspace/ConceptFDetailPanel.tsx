'use client';
import {restoreDetailFocus} from '@/lib/conceptFFocusReturn';
import {useEffect,useLayoutEffect,useId,useRef,type ReactNode} from 'react';
/** Non-modal inline drilldown: page context remains navigable on every width. */
export function ConceptFDetailPanel({title,onClose,children,returnFocusId,fallbackFocusId}:{title:string;onClose:()=>void;children:ReactNode;returnFocusId?:string;fallbackFocusId?:string}){
 const panel=useRef<HTMLElement>(null),close=useRef(onClose),focusReturn=useRef(returnFocusId),fallbackReturn=useRef(fallbackFocusId);
 useLayoutEffect(()=>{close.current=onClose;focusReturn.current=returnFocusId;fallbackReturn.current=fallbackFocusId;},[onClose,returnFocusId,fallbackFocusId]);
 const id=useId();
 useEffect(()=>{
  const trigger=document.activeElement instanceof HTMLElement&&document.activeElement!==document.body?document.activeElement:null;
  panel.current?.focus();
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!event.defaultPrevented&&!document.querySelector('[data-navigation-layer],[role="dialog"][aria-modal="true"]')&&Array.from(document.querySelectorAll('[data-concept-f-panel]')).at(-1)===panel.current){event.preventDefault();close.current();}};
  document.addEventListener('keydown',escape);
  return()=>{document.removeEventListener('keydown',escape);restoreDetailFocus(document,[focusReturn.current?document.getElementById(focusReturn.current):null,fallbackReturn.current?document.getElementById(fallbackReturn.current):null,trigger]);};
 },[]);
 useEffect(()=>{panel.current?.focus();},[title]);
 return <section ref={panel} data-concept-f-panel tabIndex={-1} role="region" aria-labelledby={id} className="concept-f-card min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-primary"><header className="mb-5 flex items-start justify-between gap-4"><h2 id={id} className="text-2xl font-bold">{title}</h2><button type="button" onClick={onClose} aria-label={'Close '+title} className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-xl">×</button></header>{children}</section>;
}
