import { parseInvestmentRecommendationContent } from '@/components/InvestmentRecommendationTable';
import type { RunResponse } from '@/types/api';
import { inspectStockJob } from '@/lib/stockFlowEvidence';

export type UniverseRow = { key: string; symbol: string; exchange: string; sources: string[]; actions: Record<string, string>; reasons: Record<string, string>; relatedVenues: string[] };
const keyOf = (exchange: string, symbol: string) => `${exchange.trim().toUpperCase()}:${symbol.trim().toUpperCase()}`;
/** Read-only coverage projection. Missing observations never become model rows or scores. */
export function rebalanceUniverse(runs: RunResponse[]) {
  const rows = new Map<string, UniverseRow>();
  const warnings = new Set<string>();
  const seenJobs = new Set<string>();
  const add = (exchange: string, symbol: string, source: string) => {
    if (!exchange?.trim() || !symbol?.trim()) return null;
    const key = keyOf(exchange, symbol);
    const row = rows.get(key) ?? { key, symbol: symbol.trim().toUpperCase(), exchange: exchange.trim().toUpperCase(), sources: [], actions: {}, reasons: {}, relatedVenues: [] };
    if (!row.sources.includes(source)) row.sources.push(source);
    rows.set(key, row); return row;
  };
  for (const run of runs) {
    const prompt = run.prompt ?? '';
    const holdings = /##\s*1\.\s*Latest Portfolio Snapshot([\s\S]*?)(?=\n##\s*2\.|$)/i.exec(prompt)?.[1];
    if (holdings) {
      const lines = holdings.split('\n').filter(line => line.trim().startsWith('|'));
      const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
      const header = lines.findIndex(line => /Stock Symbol/i.test(line) && /Current Units/i.test(line));
      const names = header < 0 ? [] : cells(lines[header]).map(cell => cell.toLowerCase());
      for (const line of lines.slice(header + 2)) { const values = cells(line); if (values.length !== names.length) { warnings.add('Saved holdings table has malformed rows; coverage may be incomplete.'); continue; } add(values[names.indexOf('exchange')], values[names.indexOf('stock symbol')], `Run #${run.id} saved holdings`); }
    } else warnings.add(`Run #${run.id}: saved holdings input unavailable.`);
    const swing = /##\s*2\.\s*Completed Swing Trade Runs[^\n]*([\s\S]*?)(?=\n##\s*3\.|$)/i.exec(prompt)?.[1];
    if (swing) {
      for (const block of swing.split(/(?=^###\s)/m)) {
        if (!block.includes('|')) continue;
        const parsed = parseInvestmentRecommendationContent(block);
        if (!parsed) { warnings.add(`Run #${run.id}: a saved Swing source could not be parsed; coverage may be incomplete.`); continue; }
        for (const row of parsed.rows) add(row['Exchange Symbol'], row['Stock Symbol'], `Run #${run.id} input · ${block.split('\n').find(line => line.startsWith('### '))?.slice(4) ?? 'saved Swing source'}`);
      }
    } else warnings.add(`Run #${run.id}: saved Swing inputs unavailable; no latest source is substituted.`);
    for (const link of run.run_jobs ?? []) {
      const jobKey = `${run.id}:${link.job_id}`;
      if (seenJobs.has(jobKey)) continue;
      seenJobs.add(jobKey);
      const parsed = inspectStockJob(run, link, true);
      if (parsed.state !== 'populated') warnings.add(`Run #${run.id} / Job #${link.job_id}: ${parsed.state}; coverage is incomplete.`);
      for (const cells of parsed.rows) {
        const row = add(cells['Exchange Symbol'], cells['Stock Symbol'], `Run #${run.id} output`);
        if (!row) continue;
        const id = `${run.id}:${link.job_id}`;
        if (row.actions[id]) { warnings.add(`Duplicate decision for ${row.key} in Job #${link.job_id}; review original output.`); row.actions[id] = 'Conflicting duplicate output'; }
        else row.actions[id] = cells['Action (Buy/Add/Sell All/Trim/Hold/Buy New)'] || 'Action unavailable';
        row.reasons[id] = cells['Rationale Cruxx'] || cells['Rationale Remarks'] || 'No reason recorded';
      }
    }
  }
  for (const row of rows.values()) row.relatedVenues = [...rows.values()].filter(other => other.symbol === row.symbol && other.exchange !== row.exchange).map(other => other.exchange);
  return { rows: [...rows.values()].sort((a,b) => a.key.localeCompare(b.key)), warnings: [...warnings] };
}
