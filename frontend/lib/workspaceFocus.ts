/** Closed details can retain layout boxes for absolute descendants. A rectangle
 * alone is not proof of keyboard visibility. The summary itself remains usable. */
export function workspaceFocusable(root:HTMLElement|null):HTMLElement[]{
 return Array.from(root?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),summary')??[]).filter(element=>{
  if(!element.getClientRects().length||element.closest('[hidden],[inert]'))return false;
  let ancestor:HTMLElement|null=element;
  while(ancestor&&ancestor!==root){
   if(ancestor.tagName==='DETAILS'&&!ancestor.hasAttribute('open')){
    const summary=Array.from(ancestor.children).find(child=>child.tagName==='SUMMARY');
    if(!summary?.contains(element))return false;
   }
   ancestor=ancestor.parentElement;
  }
  return true;
 });
}
