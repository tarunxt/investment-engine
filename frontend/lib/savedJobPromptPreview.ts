import {savedTextPages} from './conceptFSavedText';
/** Screen the entire source before any preview/clamp; never disclose a safe-looking secret prefix. */
export function savedJobPromptPreview(value:unknown){
 const result=savedTextPages(value);
 if(result.state==='restricted')return 'Saved prompt restricted';
 if(result.state==='over_bound')return 'Saved prompt exceeds safe display bound';
 if(result.state!=='available')return 'Saved prompt unavailable';
 return result.pages[0].slice(0,500)+(result.pages.length>1||result.pages[0].length>500?'…':'');
}
