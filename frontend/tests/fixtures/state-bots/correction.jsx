import React from 'react';
import { createRoot } from 'react-dom/client';
import { TradingBotsOverviewPage } from '../../../app/console/trading-bots/_components/TradingBotsOverviewPage';
import { StageTwoLlmRunDetailsDialog } from '../../../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard';
import { buildBullpenAutoRunWorkflowView } from '../../../app/console/bullpen-ai/_components/bullpenAutoRunProgress';
import BullpenAiPage from '../../../app/console/bullpen-ai/_components/BullpenAiPageClient';
window.__fixtureName = location.hash.slice(1) || 'overview';
window.__rejectReads = [];
if (['zero', 'cached'].includes(window.__fixtureName)) {
  const snapshot = { mode: '30-days', snapshotId: 'synthetic-saved-zero', scannedAt: '2026-11-01T00:00:00Z', sourceUrl: 'synthetic', sourceLabel: 'Synthetic saved snapshot', totalCandidates: window.__fixtureName === 'cached' ? 12 : 0, questions: [], filters: {}, rejectedQuestions: [] };
  const history = { '30-days': { current: snapshot, history: [] }, 'end-of-month': { current: null, history: [] } };
  localStorage.setItem('investment-engine:bullpen-ai:snapshots:v2', JSON.stringify({manual: history, auto: history}));
}
const run = { id: 'synthetic-saved-run', status: 'completed', started_at: '2026-11-01T00:00:00Z', completed_at: '2026-11-01T00:00:00Z', stage_results: [{stage_number: 2, stage_name: 'LLM', status:'pass', started_at:'2026-11-01T00:00:00Z', completed_at:'2026-11-01T00:00:00Z', outputs: {phase_status: 'completed', llms_selected: 0, llms_completed:0}, inputs:{}, guardrails_checked:[], hard_block:false}], guardrail_checks:[], decisions_count:0, orders_planned:0, orders_submitted:0, summary:'Synthetic saved zero run' };
const savedStage = buildBullpenAutoRunWorkflowView(run).stages.find(stage => stage.key === 'llm');
createRoot(document.getElementById('root')).render(window.__fixtureName === 'saved-diagnostics' ? <StageTwoLlmRunDetailsDialog state={{run, stage: savedStage, decisions: []}} onClose={() => {window.__closed = true;}} /> : window.__fixtureName === 'overview' ? <TradingBotsOverviewPage /> : <BullpenAiPage />);
