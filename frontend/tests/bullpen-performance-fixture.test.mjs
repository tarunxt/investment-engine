import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { bullpenPerformanceFixture } from '../scripts/fixtures/bullpen-performance.mjs';
const source=readFileSync(new URL('../app/console/bullpen-ai/_components/bullpenAutoRunStatus.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const status=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const now='2026-01-01T00:00:00Z';
test('benchmark uses valid empty provider collection and real persisted-status contract',()=>{
 assert.deepEqual(bullpenPerformanceFixture('/providers',now),[]);
 const normalized=status.normalizeBullpenAutoRunStatusData(bullpenPerformanceFixture('/polymarket/auto-live/status',now));
 assert.ok(normalized);assert.equal(normalized.state.running,false);assert.equal(normalized.settings.auto_live_enabled,false);
});
test('benchmark summary and portfolio expose required collections without activating actions',()=>{
 const summary=bullpenPerformanceFixture('/polymarket/auto-live/summary/dashboard',now);
 for(const rows of [summary.latest_guardrail_checks,summary.state.latest_guardrail_checks,summary.recent_runs,summary.recent_decisions,summary.settings.console_llm_targets])assert.deepEqual(rows,[]);
 assert.equal(summary.settings.auto_live_enabled,false);assert.equal(summary.state.live_execution_allowed,false);
 const wallet=bullpenPerformanceFixture('/polymarket/state',now);
 for(const rows of [wallet.open_positions,wallet.trade_history,wallet.live.pending_confirmations,wallet.live.redeemed_trades])assert.deepEqual(rows,[]);
 assert.equal(wallet.live.unlocked,false);assert.equal(wallet.live.balance.available_balance_usd,100);
 assert.equal(bullpenPerformanceFixture('/unrelated',now),null);
});
test('missing meaningful UI readiness is explicitly a failed measurement',()=>{
 const measurement=readFileSync(new URL('../scripts/performance-audit.mjs',import.meta.url),'utf8');
 assert.match(measurement,/if \(!appeared\) throw new Error\(`Meaningful \$\{targetName\} UI did not become ready`\)/);
});
