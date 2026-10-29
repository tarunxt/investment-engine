import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const jsx=(type,props,key)=>({type,props,key});
function compile(file,imports){const result={};new Function('require','exports',ts.transpileModule(read(file),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText)(name=>{assert.ok(name in imports,`Unexpected dependency ${name}`);return imports[name];},result);return result;}
const policy=compile('../lib/modulePolicy.ts',{});
const seed=JSON.parse(read('./fixtures/stage08-ready-manifest.json'));
const nodes=v=>v&&typeof v==='object'?[v,...[v.props?.children].flat(Infinity).flatMap(nodes)]:[];
function render(selected,{unavailable=false,denied=false,failed=false,pathname='/console/dashboard'}={}){
 const manifest=structuredClone(seed);for(const m of manifest.modules){m.selection.enabled=selected.includes(m.module_id);m.availability.available=!unavailable;m.capabilities.view.allowed=!denied;}
 let opened=0;
 const ui=compile('../components/workspace/ConceptFNavigation.tsx',{'react/jsx-runtime':{jsx,jsxs:jsx},'next/link':{default:'a'},'lucide-react':{Clock3:'Clock3',Compass:'Compass',LayoutGrid:'LayoutGrid',WalletMinimal:'WalletMinimal'},'@/providers/ModuleContext':{useModules:()=>({manifest:failed?null:manifest})},'@/lib/modulePolicy':policy});
 return {tree:nodes(ui.ConceptFMobileNavigation({pathname,onMore:()=>opened++})),opened:()=>opened,header:ui.ConceptFHeader};
}
for(const [selected,expected] of [[[],null],[['zerodha_rebalance'],'/console/zerodha/portfolio'],[['indmoney_us'],'/console/indmoney-us/portfolio'],[['zerodha_rebalance','indmoney_us'],'/console/zerodha/portfolio']])test(`mobile module target respects selection ${selected}`,()=>{
 const {tree}=render(selected);const links=tree.filter(n=>n.type==='a');assert.deepEqual(links.map(n=>n.props.href),['/console/dashboard',...(expected?[expected]:[]),'/console/profile/activity']);assert.ok(links.every(n=>n.props.prefetch===false));
});
for(const state of [{unavailable:true},{denied:true},{failed:true}])test(`mobile portfolio fails closed ${JSON.stringify(state)}`,()=>{assert.deepEqual(render(['zerodha_rebalance'],state).tree.filter(n=>n.type==='a').map(n=>n.props.href),['/console/dashboard','/console/profile/activity']);});
test('More opens existing accessible navigation without dispatch or fetching',()=>{const r=render([]);const button=r.tree.find(n=>n.type==='button');assert.equal(button.props['aria-controls'],'console-sidebar');assert.equal(button.props['aria-expanded'],false);button.props.onClick({currentTarget:{id:'synthetic-trigger'}});assert.equal(r.opened(),1);});
test('active state follows canonical portfolio route and no unrelated module is linked',()=>{const {tree}=render(['indmoney_us'],{pathname:'/console/indmoney-us/portfolio'});assert.deepEqual(tree.filter(n=>n.props?.['aria-current']==='page').map(n=>n.props.href),['/console/indmoney-us/portfolio']);assert.doesNotMatch(JSON.stringify(tree),/bullpen|zerodha|admin/);});

test('account utility breadcrumbs preserve the supplied Profile section without changing canonical routes',()=>{const {header}=render([]);for(const pathname of ['/console/profile/privacy','/console/profile/privacy/requests','/console/profile/research-library'])assert.match(header({pathname}).props.children[0].props.children.join(''),/Workspace \/ Profile/);assert.match(header({pathname:'/console/profile/get-started'}).props.children[0].props.children.join(''),/Workspace \/ Overview/);assert.match(header({pathname:'/console/profile/activity'}).props.children[0].props.children.join(''),/Workspace \/ Activity/);});

test('both canonical research branches use the reference Research breadcrumb without changing portfolio paths',()=>{const {header}=render([]);for(const pathname of ['/console/zerodha/research','/console/indmoney-us/research','/console/zerodha/research/legacy-setup'])assert.ok(header({pathname}).props.children[0].props.children.join('').includes('Workspace / Research'));assert.ok(header({pathname:'/console/zerodha/portfolio'}).props.children[0].props.children.join('').includes('Workspace / Zerodha'));});

test('focused historical research breadcrumb does not reclassify ordinary portfolio or audit views',()=>{const {header}=render([]);assert.match(header({pathname:'/console/auto-rebalance-runs/zerodha/94',researchHistory:true}).props.children[0].props.children.join(''),/Workspace \/ Research/);assert.match(header({pathname:'/console/auto-rebalance-runs/zerodha/94'}).props.children[0].props.children.join(''),/Workspace \/ Workspace/);});

test('final-actionable calculation breadcrumb uses Plans without reclassifying stock-flow Research',()=>{const {header}=render([]);assert.match(header({pathname:'/console/zerodha/final-actionables',planCalculation:true}).props.children[0].props.children.join(''),/Workspace \/ Plans/);assert.match(header({pathname:'/console/zerodha/final-actionables',researchHistory:true}).props.children[0].props.children.join(''),/Workspace \/ Research/);});

test('both canonical saved-plan and revision routes retain the reference Plans breadcrumb',()=>{const {header}=render([]);for(const pathname of ['/console/zerodha/plans','/console/indmoney-us/plans'])assert.match(header({pathname}).props.children[0].props.children.join(''),/Workspace \/ Plans/);});

test('exact saved diagnostic context uses Activity breadcrumb without reclassifying ordinary model history',()=>{const {header}=render([]);assert.match(header({pathname:'/console/auto-rebalance-runs/zerodha/198',diagnosticHistory:true}).props.children[0].props.children.join(''),/Workspace \/ Activity/);assert.match(header({pathname:'/console/auto-rebalance-runs/zerodha/198',researchHistory:true}).props.children[0].props.children.join(''),/Workspace \/ Research/);});

test('explicit US research summary uses portfolio breadcrumb without reclassifying ordinary research',()=>{const{header}=render([]);assert.match(header({pathname:'/console/indmoney-us/research',usResearchSummary:true}).props.children[0].props.children.join(''),/Workspace \/ INDmoney US/);assert.match(header({pathname:'/console/indmoney-us/research'}).props.children[0].props.children.join(''),/Workspace \/ Research/);});
