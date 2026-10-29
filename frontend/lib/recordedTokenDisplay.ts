/** Known zero differs from absent/invalid recorded usage; never infer billing. */
export function recordedTokenCount(value:unknown){return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value.toLocaleString():'Unknown';}
