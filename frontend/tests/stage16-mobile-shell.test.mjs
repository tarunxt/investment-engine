import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=ts.createSourceFile('ConsoleShell.tsx',readFileSync(new URL('../app/console/_components/ConsoleShell.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const elements=[];
function visit(node){if(ts.isJsxOpeningElement(node))elements.push(node);ts.forEachChild(node,visit);}visit(source);
function attr(node,name){const a=node.attributes.properties.find(p=>p.name?.getText(source)===name);return a?.initializer && ts.isStringLiteral(a.initializer)?a.initializer.text:undefined;}
const button=elements.find(n=>attr(n,'aria-label')==='Open navigation');
const main=elements.find(n=>attr(n,'data-console-shell')==='authenticated');
const classes=n=>attr(n,'className').split(/\s+/);
const spacing=(tokens,prefix)=>Number(tokens.find(c=>c.startsWith(prefix))?.slice(prefix.length))*4;
test('mobile page content clears the fixed navigation target with a visible gap',()=>{
 const control=classes(button),content=classes(main);
 assert.ok(control.includes('fixed'));assert.ok(control.includes('lg:hidden'));
 assert.ok(spacing(content,'pt-')>=spacing(control,'top-')+(spacing(control,'min-h-')||32)+16);
 assert.ok(content.includes('lg:py-6'),'desktop spacing stays compact');
});
test('mobile navigation keeps an accessible touch target and disclosure semantics',()=>{
 const control=classes(button);
 assert.ok(spacing(control,'min-h-')>=44);assert.ok(spacing(control,'min-w-')>=44);
 assert.equal(attr(button,'type'),'button');assert.equal(attr(button,'aria-controls'),'console-sidebar');
 assert.ok(button.attributes.properties.some(p=>p.name?.getText(source)==='aria-expanded'));
});
