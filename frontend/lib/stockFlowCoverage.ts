import { parseInvestmentRecommendationContent } from '@/components/InvestmentRecommendationTable';
import type { RunResponse } from '@/types/api';
import type { UniverseRow } from '@/lib/rebalanceUniverse';

/** Use exactly the saved input text, including the selected jobs, never a newer response. */
export function savedSwingInputs(runs: RunResponse[]) {
  const groups = new Map<number, { runId: number; createdAt: string; jobs: { key: string; jobId: number | null; label: string; symbols: string[] }[] }>();
  for (const run of runs) {
    const section = /##\s*2\.\s*Completed Swing Trade Runs[^\n]*([\s\S]*?)(?=\n##\s*3\.|$)/i.exec(run.prompt ?? '')?.[1] ?? '';
    for (const match of section.matchAll(/^## Swing Trade Run #(\d+)[^\n]*\n([\s\S]*?)(?=^## Swing Trade Run |$(?![\s\S]))/gm)) {
      const runId = Number(match[1]), body = match[2];
      const group = groups.get(runId) ?? { runId, createdAt: /^Created:\s*([^;\n]+)/m.exec(body)?.[1]?.trim() ?? '', jobs: [] };
      let sourceIndex = 0;
      for (const block of body.split(/(?=^### )/m)) {
        const heading = /^### (.+)/m.exec(block)?.[1];
        if (!heading) continue;
        const jobId = Number(/Job #(\d+)/.exec(heading)?.[1]) || null;
        const key = jobId ? `job:${jobId}` : `saved-output:${++sourceIndex}`;
        if (group.jobs.some(job => job.key === key)) continue;
        const parsed = parseInvestmentRecommendationContent(block);
        group.jobs.push({ key, jobId, label: jobId ? heading : `${heading} · Saved output ${sourceIndex} (job ID not recorded)`, symbols: [...new Set((parsed?.rows ?? []).map(row => `${row['Exchange Symbol'] || '-'}:${row['Stock Symbol'] || '-'}`))].sort() });
      }
      groups.set(runId, group);
    }
  }
  return [...groups.values()].sort((a,b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || b.runId - a.runId);
}

export function uncoveredFinalListings(universe: UniverseRow[], displayed: { stock: { exchange: string; symbol: string } }[]) {
  const keys = new Set(displayed.map(row => `${row.stock.exchange.trim().toUpperCase()}:${row.stock.symbol.trim().toUpperCase()}`));
  return universe.filter(row => !keys.has(row.key)).map(row => ({
    ...row,
    disposition: Object.values(row.actions).length && Object.values(row.actions).every(action => action.trim() === 'Hold') ? 'No trade' : 'Not actionable',
    explanation: Object.values(row.actions).length && Object.values(row.actions).every(action => action.trim() === 'Hold')
      ? 'All available model decisions are Hold; no trade is proposed. Recorded reasons: '
      : 'No eligible formula action is available for this listing. Recorded reasons: ',
  }));
}
