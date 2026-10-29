import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import ts from 'typescript';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8'),jsx=(type,props,key)=>({type,props,key});
function fn(file,name,values){const source=read(file),tree=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),node=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name),js=ts.transpileModule(node.getText(tree),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;return new Function(...Object.keys(values),'require','exports',js+`;return ${name};`)(...Object.values(values),()=>({jsx,jsxs:jsx}),{});}
test('profile/preferences lifetimes reset on owner and session, mismatch hides old form',()=>{let id='1',generation='a',status='authenticated',user={id:1};const session=()=>({status,data:{user:{id},generation}});const Profile=fn('../app/console/profile/page.tsx','ProfilePage',{useSession:session,useAuth:()=>({user}),OwnedProfilePage:'form'}),Preferences=fn('../app/console/profile/preferences/page.tsx','PreferencesPage',{useSession:session,OwnedPreferencesPage:'form'});assert.equal(Profile().key,'1:a');assert.equal(Preferences().key,'1:a');id='2';assert.equal(Profile().type,'p');user={id:2};assert.equal(Profile().key,'2:a');assert.equal(Preferences().key,'2:a');generation='b';assert.equal(Profile().key,'2:b');assert.equal(Preferences().key,'2:b');status='unauthenticated';assert.equal(Profile().type,'p');assert.equal(Preferences().type,'p');});
function preferencesHarness(){
 let resolve;
 const effects=[],writes=[],listeners=[],removed=[];
 const compile=(file,imports={},suffix='')=>{const out={};new Function('require','exports',ts.transpileModule(read(file)+suffix,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText)(name=>{assert.ok(name in imports,`Missing mock: ${name}`);return imports[name];},out);return out;};
 const profile=compile('../lib/conceptFProfile.ts');
 const preferences=compile('../lib/conceptFPreferences.ts',{'./conceptFProfile':profile});
 const react={useState:value=>[typeof value==='function'?value():value,value=>writes.push(['state',value])],useRef:value=>({current:value}),useEffect:effect=>effects.push(effect)};
 const theme={getStoredThemePreference:()=>null,isThemePreference:value=>['light','dark','system'].includes(value),persistThemePreference:value=>writes.push(['persist',value]),applyThemePreference:value=>writes.push(['apply',value]),THEME_CHANGED_EVENT:'test-theme',THEME_STORAGE_KEY:'test-key'};
 // Execute the complete module so module-level options and real saved-value helpers remain in scope.
 const source=read('../app/console/profile/preferences/page.tsx')+'\nexport {OwnedPreferencesPage};';
 const out={},imports={react,'next-auth/react':{},'react/jsx-runtime':{jsx,jsxs:jsx},'@/services/api':{apiService:{getProfile:()=>new Promise(done=>resolve=done)}},'@/lib/conceptFPreferences':preferences,'@/lib/conceptFProfile':profile,'@/lib/theme':theme};
 for(const [path,name] of [['modules/ModulePreferences','ModulePreferences'],['ui/button','Button'],['ui/label','Label'],['ui/separator','Separator'],['auth/FormAlert','FormAlert']])imports[`@/components/${path}`]={[name]:name};
 new Function('require','exports','window',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText)(name=>{assert.ok(name in imports,`Missing mock: ${name}`);return imports[name];},out,{addEventListener:(...args)=>listeners.push(args),removeEventListener:(...args)=>removed.push(args)});
 out.OwnedPreferencesPage();
 const cleanup=effects.map(effect=>effect());
 assert.deepEqual(writes,[['state',false],['state',null]],'mount resets loaded/error state before the read');
 writes.length=0;
 return {writes,listeners,removed,unmount:()=>cleanup.forEach(stop=>stop?.()),resolve:async()=>{resolve({timezone:'UTC',theme_preference:'dark',notification_preferences:'all'});for(let i=0;i<10;i++)await Promise.resolve();}};
}
test('late preference result cannot apply previous owner theme after unmount',async()=>{
 const h=preferencesHarness();h.unmount();await h.resolve();
 assert.deepEqual(h.writes,[]);assert.equal(h.listeners.length,2);assert.deepEqual(h.removed,h.listeners);
});
test('mounted preference result applies validated saved values and theme',async()=>{
 const h=preferencesHarness();await h.resolve();
 assert.deepEqual(h.writes,[['state',{timezone:'UTC',notification_preferences:'all',theme_preference:'dark'}],['state',true],['state',null],['persist','dark'],['apply','dark']]);h.unmount();
});
test('utilities preserve admin guard and distinguish privacy/download/notification limits',()=>{const frame=read('../app/console/profile/ProfileFrame.tsx');for(const label of ['Connections','My modules','Usage & plan','Notifications','Privacy & exports','Help','My Activity'])assert.ok(frame.includes(label));assert.match(frame,/costAccessOwner===user\?\.id/);const privacy=read('../app/console/profile/privacy/page.tsx');assert.match(privacy,/Real account erasure remains disabled/);assert.match(privacy,/not a complete account export/);assert.doesNotMatch(privacy,/apiService|fetch\(|<button/);assert.match(read('../app/console/profile/preferences/page.tsx'),/not proof of delivery/);assert.match(read('../app/console/profile/security/page.tsx'),/does not manage Google or brokerage credentials/);});
test('mobile bar and keyboard clearance replace floating overlap; reduced motion is scoped',()=>{const shell=read('../app/console/_components/ConsoleShell.tsx'),css=read('../app/globals.css');assert.match(shell,/sticky top-0 z-10 flex h-16/);assert.doesNotMatch(shell,/fixed left-4 top-4/);assert.match(shell,/min-h-11 min-w-11/);assert.match(css,/scroll-margin-block: 5rem 1rem/);assert.match(css,/prefers-reduced-motion: reduce/);assert.match(css,/\[data-workspace-shell\] \*::after/);});


test('closed details descendants with rectangles cannot break drawer wrap; summaries stay focusable',()=>{
 const out={};new Function('exports',ts.transpileModule(read('../lib/workspaceFocus.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(out);
 const root={tagName:'DIV'},details={tagName:'DETAILS',parentElement:root,children:[],hasAttribute:()=>false};
 const element=(tag,parent=details)=>({tagName:tag,parentElement:parent,closest:()=>null,getClientRects:()=>[{}],hasAttribute:()=>false});
 const summary=element('SUMMARY');summary.contains=el=>el===summary;details.children=[summary];const hidden=element('BUTTON'),visible=element('A',root);root.querySelectorAll=()=>[visible,summary,hidden];
 assert.deepEqual(out.workspaceFocusable(root),[visible,summary]);details.hasAttribute=()=>true;assert.deepEqual(out.workspaceFocusable(root),[visible,summary,hidden]);hidden.closest=()=>({});assert.deepEqual(out.workspaceFocusable(root),[visible,summary]);
});
