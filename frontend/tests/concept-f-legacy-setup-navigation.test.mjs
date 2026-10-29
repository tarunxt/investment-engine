import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,nodes,text} from './helpers/workspace-hooks.mjs';
function setup(owner=1,portfolio='india'){
 return harness(new URL('../components/workspace/ConceptFLegacySetup.tsx',import.meta.url),'OwnedLegacySetup',{owner,portfolio,promptId:null,source:null},{Link:'a',ConceptFSetupSourceCatalogue:'source-catalogue',ConceptFSavedText:'saved-text',ConceptFModelMixLibrary:'mix-library',recordedCostTimestamp:()=>null,moduleRoot:p=>'/console/'+p,useWorkspaceDisplay:()=>({value:{masked:true}}),safeResearchData:v=>v});
}
test('F45 section links name four real focusable destinations without pretending to be hidden-panel tabs',()=>{
 const h=setup(),nav=nodes(h.tree()).find(n=>n.type==='nav'&&n.props['aria-label']==='Legacy setup sections');assert.ok(nav);const links=nodes(nav).filter(n=>n.type==='a');assert.deepEqual(links.map(text),['Sources','Prompt template','Schedule preview','Review']);
 for(const link of links){assert.match(link.props.href,/^#/);assert.equal(link.props.onClick,undefined);const targets=nodes(h.tree()).filter(n=>n.props?.id===link.props.href.slice(1));assert.equal(targets.length,1);assert.equal(targets[0].props.tabIndex,-1);assert.ok(nodes(h.tree()).find(n=>n.props?.id===targets[0].props['aria-labelledby']));}
 assert.equal(nodes(h.tree()).some(n=>['tab','tablist','tabpanel'].includes(n.props?.role)),false);assert.equal(h.requests.length,0);h.cleanup();
});
test('F45 responsive hierarchy places sources and prompt left, schedule and review right, in mobile reading order',()=>{
 const h=setup(),all=nodes(h.tree()),grid=all.find(n=>n.props?.className?.includes('lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]'));assert.ok(grid);assert.match(grid.props.className,/\bgrid\b/);assert.doesNotMatch(grid.props.className,/(?:^|\s)grid-cols-2(?:\s|$)/);
 const groups=nodes(grid),inputs=groups.find(n=>n.props?.['aria-label']==='Source evidence and prompt draft'),aside=groups.find(n=>n.type==='aside'&&n.props['aria-label']==='Schedule and local review');assert.ok(inputs);assert.ok(aside);assert.ok(groups.indexOf(inputs)<groups.indexOf(aside));assert.match(text(inputs),/Sources and exact input jobs/);assert.match(text(inputs),/Prompt template and local editor/);assert.ok(nodes(inputs).some(n=>n.type==='source-catalogue'));assert.doesNotMatch(text(inputs),/Optional local date and time/);assert.match(text(aside),/Optional local date and time/);assert.ok(nodes(aside).some(n=>n.type==='button'&&text(n)==='Review setup only'));h.cleanup();
});
test('section targets remain unique across owned portfolios and no draft is hidden by navigation',async()=>{
 const india=setup(1,'india'),us=setup(2,'indmoney_us');const ids=h=>nodes(h.tree()).filter(n=>n.props?.id).map(n=>n.props.id);assert.ok(ids(india).length>=8);assert.equal(ids(india).some(id=>ids(us).includes(id)),false);
 india.control('Optional local date and time').props.onChange({target:{value:'2026-11-01T10:30'}});await india.flush();assert.equal(india.control('Optional local date and time').props.value,'2026-11-01T10:30');assert.equal(nodes(india.tree()).filter(n=>n.type==='nav'&&n.props['aria-label']==='Legacy setup sections').length,1);assert.equal(india.requests.length,0);assert.match(india.text(),/no recurring schedule/);india.cleanup();us.cleanup();
});
test('review navigation is not a submit action; deliberate review retains existing validation',async()=>{
 const h=setup();h.button('Review setup only').props.onClick();await h.flush();assert.match(h.text(),/Apply an explicit advisory model selection/);assert.doesNotMatch(h.text(),/Exact local setup review/);assert.equal(h.requests.length,0);assert.equal(nodes(h.tree()).some(n=>n.type==='form'),false);h.cleanup();
});
