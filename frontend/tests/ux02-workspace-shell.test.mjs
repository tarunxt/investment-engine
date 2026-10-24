import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const jsx=(type,props,key)=>({type,props,key});
function compile(file,imports){const result={};new Function('require','exports',ts.transpileModule(read(file),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText)(name=>{assert.ok(name in imports,`Unexpected import ${name}`);return imports[name];},result);return result;}
const policy=compile('../lib/modulePolicy.ts',{});
const seed=JSON.parse(read('./fixtures/stage08-ready-manifest.json'));
function navigation({selected=[],admin=false,failed=false,pathname='/console/zerodha/rebalance'}={}){
 const manifest=structuredClone(seed);for(const m of manifest.modules)m.selection.enabled=selected.includes(m.module_id);
 const ui=compile('../app/console/_components/WorkspaceNavigation.tsx',{'react/jsx-runtime':{jsx,jsxs:jsx},'next/link':{default:'a'},'@/providers/ModuleContext':{useModules:()=>({manifest:failed?null:manifest,error:failed?'synthetic timeout':null,loading:false})},'@/lib/modulePolicy':policy,'lucide-react':new Proxy({},{get:(_,name)=>String(name)}),'./SidebarThemeToggle':{SidebarThemeToggle:'ThemeToggle'}});
 return ui.WorkspaceNavigation({pathname,user:{full_name:'Synthetic Customer',email:'synthetic@example.test',role:admin?'admin':'user'},onNavigate(){}});
}
for(const state of [{},{failed:true},{selected:['zerodha_rebalance']},{selected:['indmoney_us']},{selected:['zerodha_rebalance','indmoney_us']}])test(`navigation stable and selected: ${JSON.stringify(state)}`,()=>{
 const text=JSON.stringify(navigation(state));for(const label of ['Dashboard','My Activity','Connections','Usage & plan','Help','Synthetic Customer'])assert.ok(text.includes(label));
 assert.equal(text.includes('/console/zerodha"'),state.selected?.includes('zerodha_rebalance')??false);assert.equal(text.includes('/console/indmoney-us"'),state.selected?.includes('indmoney_us')??false);
 assert.doesNotMatch(text,/Administrator workspace|bullpen-ai/);
});
test('admin workspace is explicit and identity never uses internal subject',()=>{assert.match(JSON.stringify(navigation({admin:true})),/Administrator workspace/);assert.doesNotMatch(JSON.stringify(navigation()),/7101|subject/);});
test('administrator admission checks current backend role before choosing provider view',async()=>{
 let user={role:'user',is_active:true};let calls=[];
 const ui=compile('../app/console/_components/adminAccess.ts',{'next/headers':{headers:async()=>({})},'@/app/api/bullpen-ai/_lib/serverBackendSession':{createBackendSessionContext:async()=>({}),fetchBackendJsonWithSession:async(_,path)=>{calls.push(path);return user;}}});
 assert.equal(await ui.currentAdministrator(),false);user={role:'admin',is_active:true};assert.equal(await ui.currentAdministrator(),true);user.is_active=false;assert.equal(await ui.currentAdministrator(),false);assert.deepEqual(calls,['/auth/me','/auth/me','/auth/me']);
});
test('legacy APIs standard customer renders only personal usage; layout has no automatic provider component',async()=>{
 const ui=compile('../app/console/apis/page.tsx',{'react/jsx-runtime':{jsx,jsxs:jsx},'@/components/account/PersonalUsage':{PersonalUsage:'personal'},'../_components/adminAccess':{currentAdministrator:async()=>false},'./AdminApiUsage':{default:'provider'},'./_components/LlmUsageBreakdown':{default:'providerBreakdown'}});
 assert.equal((await ui.default()).type,'personal');assert.doesNotMatch(read('../app/console/apis/layout.tsx'),/LlmUsageBreakdown/);
});
test('existing cost-only admission retains its profile link without provider-admin navigation',()=>{
 let owner=7102;
 const urls={routes:{profile:{root:()=>'/console/profile',preferences:()=>'/console/profile/preferences',costDrivers:()=>'/console/profile/cost-drivers',security:()=>'/console/profile/security',activity:()=>'/console/profile/activity'}}};
 const ui=compile('../app/console/profile/ProfileFrame.tsx',{'react/jsx-runtime':{jsx,jsxs:jsx},'next/link':{default:'a'},'next/navigation':{usePathname:()=>'/console/profile'},'@/hooks/useAuth':{useAuth:()=>({user:{id:owner,role:'user'}})},'@/lib/urls':{URLs:urls},'@/lib/utils':{cn:(...values)=>values.filter(Boolean).join(' ')}});
 assert.match(JSON.stringify(ui.ProfileFrame({children:'personal',costAccessOwner:7102})),/Platform Cost Drivers/);
 owner=7101;assert.doesNotMatch(JSON.stringify(ui.ProfileFrame({children:'personal',costAccessOwner:7102})),/Platform Cost Drivers/);
});

test("administrator deep link reaches the server permission state inside the shell",()=>{const proxy=readFileSync(new URL("../proxy.ts",import.meta.url),"utf8");assert.doesNotMatch(proxy,/path\.startsWith\("\/console\/admin"\)/);});

function elements(node){if(!node||typeof node!=='object')return [];return [node,...[node.props?.children].flat(Infinity).flatMap(elements)];}
test('profile and preferences are discoverable without opening an account disclosure',()=>{
 const tree=elements(navigation());assert.equal(tree.some(x=>x.type==='details'),false);
 for(const href of ['/console/profile','/console/profile/preferences','/console/profile/usage'])assert.equal(tree.filter(x=>x.type==='a'&&x.props.href===href).length,1);
 assert.ok(tree.some(x=>x.props?.['aria-label']==='Your account'));
 assert.ok(tree.some(x=>x.type==='ThemeToggle'));
});
test('active module and settings states are specific and every decorative icon is hidden from accessibility names',()=>{
 for(const [pathname,selected,expected] of [['/console/zerodha/research',['zerodha_rebalance'],'/console/zerodha'],['/console/profile/preferences',[],'/console/profile/preferences'],['/console/profile',[],'/console/profile']]){
  const tree=elements(navigation({pathname,selected}));
  assert.deepEqual(tree.filter(x=>x.type==='a'&&x.props['aria-current']==='page').map(x=>x.props.href),[expected]);
  const icons=tree.filter(x=>['LayoutDashboard','BriefcaseBusiness','Settings2','UserRound'].includes(x.type));assert.ok(icons.length>=3);assert.ok(icons.every(x=>x.props['aria-hidden']==='true'&&x.props.focusable==='false'));
 }
});
