/** Full-image visual QA index. Pair generation is never visual acceptance. */
import {readdirSync,readFileSync,writeFileSync,mkdirSync,statSync,existsSync} from 'node:fs';
import {resolve,join,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import sharp from 'sharp';
const options=Object.fromEntries(process.argv.slice(2).reduce((rows,value,index,args)=>index%2?rows:[...rows,[value,args[index+1]]],[]));
const references=options['--references'],root=options['--evidence-root'],output=options['--output'];
if(!references||!root||!output)throw new Error('Required: --references DIR --evidence-root DIR --output DIR');
if(resolve(references)===resolve(output)||resolve(root)===resolve(output))throw new Error('A new separate output directory is required');
mkdirSync(output,{recursive:true});
const fallback={'credx-concept-f-wave1-066062f':'066062f','credx-concept-f-wave2-a683166-retry3':'a683166'};
const sha=value=>createHash('sha256').update(value).digest('hex');
const candidates=[];
for(const name of readdirSync(root)){
 if(!name.startsWith('credx-concept-f'))continue;
 const directory=join(root,name),receipt=join(directory,'receipt.json');if(!existsSync(receipt))continue;
 let value;try{value=JSON.parse(readFileSync(receipt,'utf8'));}catch{continue;}
 if(value.passed!==true||value.source_binding_verified===false||!Array.isArray(value.screenshots))continue;
 let commit=value.source_sha,binding=value.source_binding_verified===true?'archive source / compiled asset and backend tree verified before and after run':'legacy receipt label; no compiled-asset binding; source/state qualification limited';
 if(['credx-concept-f-visual-sweep-native','credx-concept-f-actionable-workbench-native'].includes(name))continue; // retained mislabeled-HEAD receipts; fresh asset-bound qualification required.
 if(!commit&&fallback[name]){commit=execFileSync('git',['rev-parse',fallback[name]],{encoding:'utf8'}).trim();binding='prior exact build/progress record; receipt lacks embedded SHA';}
 if(!/^[a-f0-9]{40}$/.test(commit??''))continue;
 let distance;try{execFileSync('git',['merge-base','--is-ancestor',commit,'HEAD']);distance=Number(execFileSync('git',['rev-list','--count',commit+'..HEAD'],{encoding:'utf8'}));}catch{continue;}
 for(const screenshot of value.screenshots){if(typeof screenshot!=='string'||!/^F\d{2}[-\w.]*\.png$/.test(screenshot))continue;const file=join(directory,screenshot);if(existsSync(file))candidates.push({id:screenshot.slice(0,3),file,screenshot,commit,binding,distance,receipt:name+'/receipt.json',mtime:statSync(file).mtimeMs});}
}
const records=[];
for(let index=1;index<=57;index++){
 const id='F'+String(index).padStart(2,'0'),reference=join(references,id+'.png');if(!existsSync(reference))throw new Error('Missing original reference '+id);
 const variants=candidates.filter(row=>row.id===id).sort((a,b)=>a.distance-b.distance||Number(!a.screenshot.includes('desktop'))-Number(!b.screenshot.includes('desktop'))||b.mtime-a.mtime);
 const record={id,reference_sha256:sha(readFileSync(reference)),captured:variants.length>0,full_visual_accepted:false,hosted_accepted:false,variants:variants.map(({file,mtime,distance,...row})=>row)};
 if(variants.length){const actual=variants[0],a=await sharp(reference).metadata(),b=await sharp(actual.file).metadata(),width=Math.max(a.width,b.width),height=Math.max(a.height,b.height);const canvas=()=>sharp({create:{width,height,channels:4,background:'#ffffff'}});const ref=await canvas().composite([{input:reference,left:0,top:0}]).png().toBuffer(),image=await canvas().composite([{input:actual.file,left:0,top:0}]).png().toBuffer();await sharp({create:{width:width*2,height,channels:4,background:'#ffffff'}}).composite([{input:ref,left:0,top:0},{input:image,left:width,top:0}]).png().toFile(join(output,id+'-pair.png'));await sharp(ref).composite([{input:image,blend:'difference'}]).png().toFile(join(output,id+'-difference.png'));Object.assign(record,{actual_sha256:sha(readFileSync(actual.file)),source_sha:actual.commit,source_binding:actual.binding,receipt:actual.receipt,pair:id+'-pair.png',difference:id+'-difference.png',reference_dimensions:[a.width,a.height],actual_dimensions:[b.width,b.height],cropped:false,scaled:false,padded:true,status:'Paired variant; state/data/viewport differences and full visual review remain open'});
 }else record.status='No source-bound passing local capture indexed; visual qualification remains open';
 records.push(record);
}
const result={recorded_at:new Date().toISOString(),screens:57,captured_ids:records.filter(row=>row.captured).length,full_visual_accepted:0,hosted_accepted:0,note:'All images retain full dimensions. Padding only; no crop/scale. Older source/state captures are listed with their exact binding limits. Pairs are review inputs, never parity or functional acceptance.',records};
writeFileSync(join(output,'visual-evidence-index.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({screens:result.screens,captured_ids:result.captured_ids,full_visual_accepted:0,hosted_accepted:0,output:basename(output)}));
