'use client';
import {useEffect,useRef,useState,type ReactNode,type PointerEvent as ReactPointerEvent} from 'react';
import {boundPanelPosition} from '@/lib/conceptFMovablePanel';
/** Owner-scoped caller supplies content; this UI has no storage, request or financial adapter. */
export function ConceptFMovablePanel({title,onClose,children}:{title:string;onClose:()=>void;children:ReactNode}){
 const [position,setPosition]=useState({x:0,y:0});
 const panel=useRef<HTMLElement>(null),close=useRef(onClose);
 const dragging=useRef<{pointer:number;x:number;y:number;origin:{x:number;y:number}}|null>(null);
 useEffect(()=>{close.current=onClose;},[onClose]);
 useEffect(()=>{
  const trigger=document.activeElement instanceof HTMLElement?document.activeElement:null;
  const node=panel.current;node?.focus();
  const keyboard=(event:KeyboardEvent)=>{
   if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();close.current();return;}
   if(event.key!=='Tab'||!node)return;
   const targets=Array.from(node.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex="0"]')).filter(target=>target.getClientRects().length>0&&!target.closest('[inert]'));
   const first=targets[0],last=targets.at(-1),active=document.activeElement;
   if(!first){event.preventDefault();node.focus();}
   else if(event.shiftKey&&(active===first||active===node||!node.contains(active))){event.preventDefault();last?.focus();}
   else if(!event.shiftKey&&(active===last||active===node||!node.contains(active))){event.preventDefault();first.focus();}
  };
  const resized=()=>{const box=panel.current;if(box)setPosition(current=>boundPanelPosition(current,{width:innerWidth,height:innerHeight},{width:box.offsetWidth,height:box.offsetHeight}));};
  document.addEventListener('keydown',keyboard);window.addEventListener('resize',resized);
  return()=>{document.removeEventListener('keydown',keyboard);window.removeEventListener('resize',resized);if(trigger?.isConnected)trigger.focus();};
 },[]);
 function move(next:{x:number;y:number}){const box=panel.current;if(box)setPosition(boundPanelPosition(next,{width:innerWidth,height:innerHeight},{width:box.offsetWidth,height:box.offsetHeight}));}
 function begin(event:ReactPointerEvent<HTMLElement>){if(event.button!==0)return;event.preventDefault();event.currentTarget.focus();dragging.current={pointer:event.pointerId,x:event.clientX,y:event.clientY,origin:position};event.currentTarget.setPointerCapture(event.pointerId);}
 function end(event:ReactPointerEvent<HTMLElement>){if(dragging.current?.pointer!==event.pointerId)return;dragging.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}
 return <div className="fixed inset-0 z-[70] flex items-start justify-center overflow-hidden bg-black/60 py-6" onPointerDown={event=>{if(event.target===event.currentTarget)onClose();}}><section ref={panel} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="concept-f-card flex min-w-0 flex-col overflow-hidden p-0 outline-none focus-visible:ring-2 focus-visible:ring-primary" style={{padding:0,width:'68rem',maxWidth:'calc(100vw - 2rem)',maxHeight:'calc(100dvh - 3rem)',transform:`translate3d(${position.x}px,${position.y}px,0)`}}><header className="grid shrink-0 gap-4 border-b p-4 sm:grid-cols-[minmax(0,1fr)_auto]"><div role="group" aria-label={'Move '+title} tabIndex={0} className="min-w-0 cursor-move touch-none rounded p-2 outline-none focus-visible:ring-2 focus-visible:ring-primary" onPointerDown={begin} onPointerMove={event=>{const start=dragging.current;if(start?.pointer===event.pointerId)move({x:start.origin.x+event.clientX-start.x,y:start.origin.y+event.clientY-start.y});}} onPointerUp={end} onPointerCancel={end} onKeyDown={event=>{const delta=({ArrowLeft:[-20,0],ArrowRight:[20,0],ArrowUp:[0,-20],ArrowDown:[0,20]} as Record<string,number[]>)[event.key];if(delta){event.preventDefault();move({x:position.x+delta[0],y:position.y+delta[1]});}else if(event.key==='Home'){event.preventDefault();setPosition({x:0,y:0});}}}><h2 className="text-xl font-bold">{title}</h2><p className="text-xs text-muted-foreground">Drag header to move · arrow keys move · Home resets</p><p className="text-xs">Advisory inspection only. No order or saved preference changes.</p></div><div className="flex shrink-0 flex-wrap gap-2"><button className="concept-f-secondary min-h-11" onClick={()=>setPosition({x:0,y:0})}>Reset position</button><button className="concept-f-secondary min-h-11" onClick={onClose}>Close score matrix popup</button></div></header><div className="min-h-0 overflow-auto p-4">{children}</div></section></div>;
}
