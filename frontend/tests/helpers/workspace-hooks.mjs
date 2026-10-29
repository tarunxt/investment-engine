import {readFileSync} from 'node:fs';
import ts from 'typescript';
export const nodes=v=>v==null||typeof v==='boolean'?[]:Array.isArray(v)?v.flatMap(nodes):typeof v==='object'?[v,...nodes(v.props?.children)]:[];
export const text=n=>typeof n==='string'||typeof n==='number'?String(n):Array.isArray(n)?n.map(text).join(''):n&&typeof n==='object'?text(n.props?.children):'';
export function harness(file,name,props,extra={}){
 const source=readFileSync(file,'utf8'),tree=ts.createSourceFile('component.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),fn=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);
 const js=ts.transpileModule(fn.getText(tree),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 let slots=[],index=0,effects=[],pendingEffects=[],rendered;const requests=[];
 const useState=initial=>{const i=index++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];};
 const useRef=value=>{const i=index++;return slots[i]??(slots[i]={current:value});};
 const useMemo=(fn,deps)=>{const i=index++;if(!slots[i]||!deps||deps.some((value,j)=>!Object.is(value,slots[i].deps?.[j])))slots[i]={deps:deps?[...deps]:null,value:fn()};return slots[i].value;};
 const useEffect=(fn,deps)=>{const i=index++;if(!effects[i]||!deps||deps.some((v,j)=>!Object.is(v,effects[i].deps?.[j])))pendingEffects.push(()=>{effects[i]?.cleanup?.();effects[i]={deps,cleanup:fn()};});};
 const request=(url,options={})=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}));
 const jsx=(type,props,key)=>({type,props,key});
 const values={useState,useRef,useEffect,useLayoutEffect:useEffect,useMemo,useCallback:(fn,deps)=>useMemo(()=>fn,deps),apiService:{fetch:request,post:(url,body)=>request(url,{method:'POST',body:JSON.stringify(body)})},ServerAnalysis:'analysis',...extra};
 const component=new Function(...Object.keys(values),'require','exports',js+`;return ${name};`)(...Object.values(values),()=>({jsx,jsxs:jsx}),{});
 function render(){index=0;rendered=component(props);const tasks=pendingEffects;pendingEffects=[];tasks.forEach(fn=>fn());}render();
 return {requests,async flush(){for(let i=0;i<12;i++)await Promise.resolve();render();},tree:()=>rendered,text:()=>text(rendered),button:label=>nodes(rendered).find(n=>n.type==='button'&&text(n)===label),control:prefix=>nodes(nodes(rendered).find(n=>n.type==='label'&&text(n).startsWith(prefix))).find(n=>['input','select','textarea'].includes(n.type)),analysis:()=>nodes(rendered).find(n=>n.type==='analysis'),cleanup:()=>effects.forEach(e=>e?.cleanup?.())};
}
