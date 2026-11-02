import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TradingBotsOverviewPage } from '../../../app/console/trading-bots/_components/TradingBotsOverviewPage';
import { StageOneOutputDialog, buildRunDetailScanCandidateDialogState, StageTwoLlmRunDetailsDialog } from '../../../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard';
import { buildBullpenAutoRunWorkflowView } from '../../../app/console/bullpen-ai/_components/bullpenAutoRunProgress';
import BullpenAiPage from '../../../app/console/bullpen-ai/_components/BullpenAiPageClient';
import { scopeBullpenWorkspaceStorageKey } from '../../../lib/bullpenStageOneSettings';
const workspaceProfile = new URLSearchParams(location.search).get('workspace') === 'bullpen-sports' ? 'bullpen-sports' : 'bullpen007';
window.__fixtureName = location.hash.slice(1) || 'overview';
window.__rejectReads = [];
if (['zero', 'cached'].includes(window.__fixtureName)) {
  const snapshot = { mode: '30-days', snapshotId: 'synthetic-saved-zero', scannedAt: '2026-11-01T00:00:00Z', sourceUrl: 'synthetic', sourceLabel: 'Synthetic saved snapshot', totalCandidates: window.__fixtureName === 'cached' ? 12 : 0, questions: [], filters: {}, rejectedQuestions: [] };
  const history = { '30-days': { current: snapshot, history: [] }, 'end-of-month': { current: null, history: [] } };
  localStorage.setItem(scopeBullpenWorkspaceStorageKey('investment-engine:bullpen-ai:snapshots:v2', workspaceProfile), JSON.stringify({manual: history, auto: history}));
}
const run = { id: 'synthetic-saved-run', status: 'completed', started_at: '2026-11-01T00:00:00Z', completed_at: '2026-11-01T00:00:00Z', stage_results: [{stage_number: 2, stage_name: 'LLM', status:'pass', started_at:'2026-11-01T00:00:00Z', completed_at:'2026-11-01T00:00:00Z', outputs: {phase_status: 'completed', llms_selected: 0, llms_completed:0}, inputs:{}, guardrails_checked:[], hard_block:false}], guardrail_checks:[], decisions_count:0, orders_planned:0, orders_submitted:0, summary:'Synthetic saved zero run' };
const savedStage = buildBullpenAutoRunWorkflowView(run).stages.find(stage => stage.key === 'llm');
function StageOneFixture() {
  const [open, setOpen] = useState(false);
  const name = window.__fixtureName.slice('stage1-'.length);
  const complete = ['zero', 'populated', 'cached', 'missing'].includes(name);
  const base = buildBullpenAutoRunWorkflowView(null).stages[0];
  const outputs = name === 'loading' ? {} : name === 'missing' ? { phase_status:'completed', accepted_candidates:null,active_positions_found:null,available_for_claim:null } : {
    phase_status: complete ? 'completed' : name === 'partial' ? 'partial' : 'failed',
    total_items: name === 'populated' || name === 'cached' ? 12 : 0,
    accepted_candidates_count: name === 'populated' || name === 'cached' ? 2 : 0,
    active_positions_total: name === 'populated' || name === 'cached' ? 1 : 0,
    available_for_claim: [],
  };
  const stage = {...base, outputs, timerCompletedAt:complete ? '2026-11-01T00:00:00Z' : null};
  if (['populated', 'cached', 'partial'].includes(name)) {
    const candidate = {question:'Synthetic retained opportunity',marketId:'synthetic-event',marketUrl:'https://example.com/synthetic-event',scanStatus:'passed',filterReasons:['Synthetic fixture reason'],closeTime:'2026-11-03T00:00:00Z',currentYesOdds:50,currentNoOdds:50,volumeUsd:100,liquidityUsd:100,returnsPerDay:null,theme:'Synthetic',slug:null,conditionId:null,questionId:null,bestBidCents:null,bestAskCents:null,spreadCents:null,forceInclude:false,forceIncludedPosition:false,selected:null,rules:null,eventDescription:null,marketContext:null,resolutionSource:null,preflightEvidenceBlock:null};
    stage.scanCandidates = [candidate];
    stage.scannedCandidates = [candidate];
  }
  const mode = new URLSearchParams(location.search).get('mode') || 'fresh-opportunities';
  const state = buildRunDetailScanCandidateDialogState({run:null,decisions:[],stage,mode});
  return <main className="p-4"><p role="status">Synthetic {workspaceProfile} {name} parent source</p><button onClick={() => setOpen(true)}>Open Stage 1 fixture</button>{open ? <StageOneOutputDialog state={state} onClose={() => setOpen(false)} workspaceProfile={workspaceProfile} /> : null}</main>;
}
createRoot(document.getElementById('root')).render(window.__fixtureName.startsWith('stage1-') ? <StageOneFixture /> : window.__fixtureName === 'saved-diagnostics' ? <StageTwoLlmRunDetailsDialog state={{run, stage: savedStage, decisions: []}} onClose={() => {window.__closed = true;}} /> : window.__fixtureName === 'overview' ? <TradingBotsOverviewPage /> : <BullpenAiPage workspaceProfile={workspaceProfile} />);
