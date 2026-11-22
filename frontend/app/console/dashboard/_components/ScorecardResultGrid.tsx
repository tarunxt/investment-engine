"use client";
const fmt=(n:number)=>Number(n.toFixed(2)).toString();
export function Grid({rows}:{rows:Record<string,unknown>[]}) {
  const columns=[...new Set(rows.flatMap(row=>Object.keys(row)))];
  return <div className="max-h-[52vh] overflow-auto"><table className="w-full border-collapse text-left text-xs"><thead className="sticky top-0 bg-slate-100"><tr>{columns.map(k=><th className="whitespace-nowrap p-2" key={k}>{k}</th>)}</tr></thead><tbody>{rows.map((r,i)=><tr className="border-b" key={i}>{columns.map(k=><td className="max-w-96 p-2 align-top" key={k}>{r[k]==null?"—":typeof r[k]==="number"?fmt(r[k] as number):typeof r[k]==="object"?<details><summary>Details</summary><pre className="max-h-60 w-72 overflow-auto whitespace-pre-wrap">{JSON.stringify(r[k],null,2)}</pre></details>:String(r[k])}</td>)}</tr>)}</tbody></table></div>;
}
