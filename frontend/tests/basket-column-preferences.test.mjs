import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../lib/basketColumnPreferences.ts',import.meta.url),'utf8');
function preferences(storage){const exports={};new Function('exports','window',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exports,{sessionStorage:storage});return exports;}

test('tab-session preferences survive a fresh reader and are isolated by owner, broker and market',()=>{
 const saved=new Map(),storage={getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value)};
 const first=preferences(storage);first.writeBasketColumnPreferences('71:Zerodha:india',['Status','Action Zerodha Amount','Status']);
 const reloaded=preferences(storage);assert.deepEqual(reloaded.readBasketColumnPreferences('71:Zerodha:india'),['Status','Action Zerodha Amount']);
 for(const scope of ['72:Zerodha:india','71:IndMoney:us','71:Zerodha:us'])assert.deepEqual(reloaded.readBasketColumnPreferences(scope),[]);
 first.writeBasketColumnPreferences('71:Zerodha:india',[]);assert.deepEqual(reloaded.readBasketColumnPreferences('71:Zerodha:india'),[]);
});

test('unavailable, blocked, malformed and oversized storage cannot break the basket',()=>{
 const blocked=preferences({getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');}});assert.deepEqual(blocked.readBasketColumnPreferences('owner'),[]);assert.doesNotThrow(()=>blocked.writeBasketColumnPreferences('owner',['Stock']));
 for(const raw of ['not JSON','null','{}','[1]','["'+ 'x'.repeat(129)+'"]',JSON.stringify(Array(101).fill('Stock'))])assert.deepEqual(preferences({getItem:()=>raw}).readBasketColumnPreferences('owner'),[]);
});

test('layout v2 migrates hidden IDs and persists stable order/names without crossing scopes',()=>{
 const saved=new Map(),storage={getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value)},p=preferences(storage);
 p.writeBasketColumnPreferences('71:Zerodha:india',['Status']);assert.deepEqual(p.readBasketColumnLayout('71:Zerodha:india'),{hidden:['Status'],order:[],names:{}});
 const layout={hidden:['Status'],order:['Units','Stock'],names:{Units:'Action quantity',Stock:'Listing'}};p.writeBasketColumnLayout('71:Zerodha:india',layout);
 assert.deepEqual(preferences(storage).readBasketColumnLayout('71:Zerodha:india'),layout);assert.deepEqual(p.readBasketColumnLayout('72:Zerodha:india'),p.emptyBasketColumnLayout());
 assert.deepEqual(p.orderedBasketColumns(['Stock','Units','Status'],['Units','missing','Units']),['Units','Stock','Status']);assert.deepEqual(p.moveBasketColumn(['Stock','Units','Status'],'Status',0),['Status','Stock','Units']);assert.deepEqual(p.moveBasketColumn(['Stock','Units'],'Stock',-1),['Stock','Units']);
 assert.deepEqual(p.normalizeBasketColumnLayout({hidden:['Status'],order:['Units'],names:{Units:' ',Stock:'x'.repeat(65)}}).names,{});
});
