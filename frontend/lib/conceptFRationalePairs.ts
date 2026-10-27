/** Exact saved-column pairing only: no score derivation or current-model substitution. */
export function savedRationalePairs(headers:readonly string[],row:Record<string,string>){
 const rationale=headers.filter(key=>/rationale/i.test(key)&&!/^score\s/i.test(key));
 const paired=new Set<string>();
 const result=rationale.map(field=>{const score=headers.find(key=>key.toLowerCase()===('Score '+field).toLowerCase())??null;if(score)paired.add(score);return{field,scoreField:score,rationale:row[field]??'',score:score?row[score]??'':''};});
 for(const field of headers.filter(key=>/^score\s.*rationale/i.test(key)&&!paired.has(key)))result.push({field,scoreField:field,rationale:'',score:row[field]??''});
 return result;
}
