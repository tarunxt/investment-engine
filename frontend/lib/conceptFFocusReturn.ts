/** Return focus only to a connected, usable target; try fallback after failed focus. */
export function restoreDetailFocus(document:Document,targets:(HTMLElement|null|undefined)[]){
 for(const target of targets){
  if(!target?.isConnected||target.matches(':disabled,[aria-disabled="true"]')||target.closest('[hidden],[inert],[aria-hidden="true"]'))continue;
  const style=document.defaultView?.getComputedStyle(target);if(style?.display==='none'||style?.visibility==='hidden')continue;
  target.focus();if(document.activeElement===target)return true;
 }
 return false;
}
