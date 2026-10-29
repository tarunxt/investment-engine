/** Reuse exact legacy naming conventions without reading/fanning out private bodies.
 * This is a library hint, never a governed stage binding or provider instruction.
 */
export function savedPromptClassification(name:unknown):string|null {
 if(typeof name!=='string')return null;
 const rules:[RegExp,string][]=[[/^portfolio event calendar scan flow$/i,'Events'],[/^(?:indmoney us|zerodha) threat scan flow$/i,'Threats'],[/^(?:india|us) swing-trade research$/i,'Swing'],[/^(?:india|us) portfolio rebalance flow$/i,'Rebalance'],[/^technical setup scan flow$/i,'Technical']];
 return rules.find(([pattern])=>pattern.test(name.trim()))?.[1]??null;
}
