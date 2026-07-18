import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Stage 2 invest list keeps shortlisted BUY_NEW rows visible until Stage 3 finishes", () => {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /if \(decision\.decision === "BUY_NEW"\) \{\s*return true;/);
  assert.match(source, /buildBullpenStage2TopTenHandoffRows/);
  assert.match(source, /Persisted Stage 2 Top 10 candidates that Stage 3 is trying to\s+execute\./);
  assert.match(source, /If a transferred event never became a concrete Step 2\s+buy plan/);
  assert.match(source, /Execution blocker \/ detail:/);
  assert.match(source, /row\.missingFromStage3/);
  assert.match(source, /formatStage2TopTenHandoffOutcome/);
  assert.match(source, /showStage2TopTenEventsSummary/);
  assert.match(source, /<Stage2TopTenEventsSummaryTable/);
  assert.match(source, /testId="stage-three-step-two-events-summary"/);
  assert.match(source, /Saved Stage 2 transfer queue/);
});

test("Stage 2 invest list can collapse into a compact Events Summary view", () => {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /const \[isCompactRows, setIsCompactRows\] = useState\(false\);/);
  assert.match(source, /Collapse Stage 2 invest rows/);
  assert.match(source, /Expand Stage 2 invest rows/);
  assert.match(source, /displayDensity=\{isCompactRows \? "compact" : "default"\}/);
});

test("Stage 2 handoff fallback reuses the canonical strongest-odds Top 10 selector", () => {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/bullpenStage2TopTenHandoff.ts",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /questionByMarketId: Map<string, BullpenQuestionRow>/);
  assert.match(source, /getBullpenTopTenStrongestLlmOddsRows/);
  assert.match(source, /\[\.\.\.questionByMarketId\.values\(\)\]/);
  assert.match(source, /return reviewedTopTenMarketIds;/);
});
