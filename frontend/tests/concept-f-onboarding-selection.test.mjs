import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const model={};new Function('exports',ts.transpileModule(readFileSync(new URL('../lib/onboarding.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(model);
const jsx=(type,props)=>({type,props});
const out={};const imports={'next/link':{default:'a'},'@/components/modules/ModulePreferences':{ModulePreferences:'module-preferences'},'@/lib/onboarding':model,'react/jsx-runtime':{jsx,jsxs:jsx}};
new Function('require','exports',ts.transpileModule(readFileSync(new URL('../components/workspace/ConceptFOnboarding.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText)(id=>{assert.ok(id in imports,`Unexpected import ${id}`);return imports[id];},out);
const nodes=n=>n==null||typeof n!=='object'?[]:Array.isArray(n)?n.flatMap(nodes):[n,...nodes(n.props?.children)];
const india={module_id:'zerodha_rebalance',label:'India',availability:{available:true}};
const us={module_id:'indmoney_us',label:'US',availability:{available:true}};
function render(choice,selected,chosen){return nodes(out.ConceptFOnboarding({step:'research',loaded:true,loading:false,error:null,storageError:false,selected,chosen,choice,onChoice:()=>{},onStep:()=>{},destination:chosen&&model.onboardingDestination(chosen.module_id,'research')}));}
test('F01 a removed saved module choice displays the same remaining module used by its destination',()=>{const tree=render(us.module_id,[india],india);const select=tree.find(n=>n.type==='select');assert.equal(select.props.value,india.module_id);assert.equal(tree.find(n=>n.type==='a'&&n.props.className==='concept-f-primary').props.href,'/console/zerodha/research');assert.ok(nodes(select).some(n=>n.type==='option'&&n.props.value===select.props.value));});
test('F01 deliberate selected choice and initial fallback stay aligned with their destinations',()=>{for(const [choice,chosen] of [[us.module_id,us],['',india]]){const tree=render(choice,[india,us],chosen);assert.equal(tree.find(n=>n.type==='select').props.value,chosen.module_id);assert.equal(tree.find(n=>n.type==='a'&&n.props.className==='concept-f-primary').props.href,model.onboardingDestination(chosen.module_id,'research'));}});
test('F01 no selection or unavailable module does not fabricate a qualified destination',()=>{assert.equal(render(us.module_id,[],undefined).some(n=>n.type==='select'),false);const unavailable={...us,availability:{available:false,reason:'Unavailable'}};assert.equal(render(us.module_id,[unavailable],unavailable).some(n=>n.type==='a'&&n.props.className==='concept-f-primary'),false);});
