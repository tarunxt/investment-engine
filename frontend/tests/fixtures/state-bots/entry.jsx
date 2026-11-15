import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TradingBotCard } from '../../../app/console/trading-bots/_components/TradingBotsOverviewPage';
import { buildTradingBotsOverviewShell } from '../../../lib/tradingBots';
import { buildTradingBotsPortfolioSummary } from '../../../app/console/trading-bots/_components/tradingBotsOverviewData';
import { buildBullpenAutoRunWorkflowView } from '../../../app/console/bullpen-ai/_components/bullpenAutoRunProgress';
import { BullpenAutoRunScheduleCard } from '../../../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard';
const fixtures = ['loading', 'success-zero', 'populated', 'failed', 'partial', 'stale-response', 'queued', 'running'];
function Fixture() {
  const [fixture, setFixture] = useState('loading');
  const [expanded, setExpanded] = useState(false);
  window.__fixtureName = fixture;
  const unknown = ['loading', 'failed'].includes(fixture);
  const base = buildTradingBotsOverviewShell().bots[0];
  const bot = unknown ? base : { ...base, source: fixture === 'stale-response' ? 'fallback' : 'api', status: fixture === 'running' ? 'running' : 'stopped', mode: 'paper', activePositionsCount: fixture === 'populated' ? 3 : 0, tradesToday: 0, guardrails: [] };
  const details = { 'bullpen-x-polymarket': null, 'polymarket-direct': null, 'bullpen-x-ai': null, 'bullpen-ai-auto-live': null };
  const totals = buildTradingBotsPortfolioSummary(fixture === 'partial' ? [bot, base] : [bot], details, '2026-11-01T00:00:00Z');
  const run = ['queued', 'running'].includes(fixture) ? { id: 'synthetic-run', status: fixture, stage_results: [], started_at: '2026-11-01T00:00:00Z', summary: '', guardrail_checks: [], decisions_count: 0, orders_planned: 0, orders_submitted: 0 } : null;
  const view = buildBullpenAutoRunWorkflowView(run);
  return <main className="mx-auto max-w-5xl space-y-4 p-4"><h1>Isolated synthetic bot status fixtures</h1><nav className="flex flex-wrap gap-2">{fixtures.map(name => <button className="rounded border p-2 focus:ring-2" key={name} onClick={() => setFixture(name)}>{name}</button>)}</nav><p role="status">Fixture: {fixture} · Bots running: {totals.botsRunning ?? 'Unknown'} · Paused/stopped: {totals.botsPausedStopped ?? 'Unknown'}</p><p>{view.statusCopy}</p><TradingBotCard bot={bot} details={details} snapshotAt="2026-11-01T00:00:00Z" expanded={expanded} onToggle={() => setExpanded(!expanded)} /><section aria-label="Actual Bullpen schedule"><BullpenAutoRunScheduleCard key={fixture} /></section></main>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
