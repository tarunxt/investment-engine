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
test('mobile navigation occupies a sticky bar before content with keyboard clearance',()=>{
 const bar=button.parent.parent;
 assert.ok(ts.isJsxElement(bar));
 const control=classes(button),container=classes(bar.openingElement),content=classes(main);
 assert.ok(container.includes('sticky')&&container.includes('top-0')&&container.includes('lg:hidden'));
 assert.ok(!control.includes('fixed')&&!container.includes('fixed'),'navigation stays in document flow');
 assert.ok(spacing(container,'h-')>=spacing(control,'min-h-')+16,'bar contains the touch target and gap');
 assert.ok(spacing(content,'py-')>=16,'content retains spacing below the bar');
 assert.ok(bar.end<main.pos,'bar precedes main content');
 assert.equal(attr(main,'id'),'workspace-main');
 const css=readFileSync(new URL('../app/globals.css',import.meta.url),'utf8');
 assert.match(css,/scroll-margin-block: 5rem 1rem/,'keyboard targets clear the sticky bar');
});
test('mobile navigation keeps an accessible touch target and disclosure semantics',()=>{
 const control=classes(button);
 assert.ok(spacing(control,'min-h-')>=44);assert.ok(spacing(control,'min-w-')>=44);
 assert.equal(attr(button,'type'),'button');assert.equal(attr(button,'aria-controls'),'console-sidebar');
 assert.ok(button.attributes.properties.some(p=>p.name?.getText(source)==='aria-expanded'));
});
