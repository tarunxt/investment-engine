import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../app/console/_components/WorkflowSurfaceSlots.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('slots.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const hook=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='useWorkflowAnchor').getText(ast);
const compiled=ts.transpileModule(hook,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(){let mutation,hash,cleanup,focus=0,scroll=0,disconnected=false;const frames=new Map();let next=0;const target={id:'india-workflow',childElementCount:0,focus:()=>focus++,scrollIntoView:()=>scroll++};const window={location:{hash:'#india-workflow'},addEventListener:(_,fn)=>hash=fn,removeEventListener:(_,fn)=>{assert.equal(fn,hash);hash=null;}};class MutationObserver{constructor(fn){mutation=fn}observe(){}disconnect(){disconnected=true}}
new Function('useEffect','window','MutationObserver','requestAnimationFrame','cancelAnimationFrame',compiled+';useWorkflowAnchor(arguments[5]);')(fn=>cleanup=fn(),window,MutationObserver,fn=>{frames.set(++next,fn);return next},id=>frames.delete(id),target);
return{target,window,mutation:()=>mutation(),hash:()=>hash(),flush:()=>{for(const [id,fn] of frames){frames.delete(id);fn()}},cleanup:()=>cleanup(),state:()=>({focus,scroll,disconnected,hash,frames:frames.size})};}
test('delayed initial focus happens once; opening and updating overlays cannot steal focus',()=>{const h=fixture();h.mutation();h.flush();assert.equal(h.state().focus,0);h.target.childElementCount=1;h.mutation();h.flush();assert.equal(h.state().focus,1);for(let i=0;i<8;i++){h.mutation();h.flush()}assert.equal(h.state().focus,1);assert.equal(h.state().scroll,1);h.cleanup();});
test('new hash-navigation request rearms focus and cleanup cancels a pending frame',()=>{const h=fixture();h.target.childElementCount=1;h.mutation();h.flush();h.hash();h.flush();assert.equal(h.state().focus,2);h.hash();assert.equal(h.state().frames,1);h.cleanup();h.flush();assert.equal(h.state().focus,2);assert.equal(h.state().disconnected,true);assert.equal(h.state().hash,null);});
