import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

async function loadStrategyModule() {
  const source = readFileSync(
    new URL("../lib/bullpenStage2To3Strategy.ts", import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: "bullpenStage2To3Strategy.ts",
  });

  return import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`,
  );
}

test("Stage 3 Planned metric keeps the strategy info button beside Planned and stops the metric click from leaking through", () => {
  const scheduleCardSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(
    scheduleCardSource,
    /<div className="flex items-center gap-1\.5">[\s\S]*Planned[\s\S]*data-testid="stage3-planned-strategy-button"/,
  );
  assert.match(
    scheduleCardSource,
    /aria-label="Explain Stage 2 to Stage 3 planned strategy"/,
  );
  assert.match(scheduleCardSource, /aria-haspopup="dialog"/);
  assert.match(scheduleCardSource, /aria-expanded=\{/);
  assert.match(scheduleCardSource, /event\.preventDefault\(\);/);
  assert.match(scheduleCardSource, /event\.stopPropagation\(\);/);
  assert.match(scheduleCardSource, /openStage2To3StrategyDialog/);
});

test("Stage 2 to Stage 3 strategy dialog includes the required accessibility hooks and policy sections", () => {
  const dialogSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenStage2To3StrategyDialog.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const strategySource = readFileSync(
    new URL("../lib/bullpenStage2To3Strategy.ts", import.meta.url),
    "utf8",
  );

  assert.match(dialogSource, /role="dialog"/);
  assert.match(dialogSource, /aria-modal="true"/);
  assert.match(dialogSource, /aria-labelledby=\{titleId\}/);
  assert.match(dialogSource, /if \(event\.key === "Escape"\)/);
  assert.match(dialogSource, /triggerRef\?\.current\?\.focus\(\)/);
  assert.match(
    dialogSource,
    /if \(event\.target === event\.currentTarget\) \{\s*onClose\(\);\s*\}/,
  );
  assert.match(dialogSource, /onMouseDown=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(dialogSource, /data-testid="stage2-to-3-strategy-dialog"/);
  assert.match(dialogSource, /Stage 2 → Stage 3 Planned Strategy/);
  assert.match(dialogSource, /including\s+exactly/);
  assert.match(dialogSource, /Failed or unsettled exits do not free cash or slots\./);
  assert.match(dialogSource, /sizingFormulaLabel/);
  assert.match(
    strategySource,
    /return `Cash in Hand \/ \(\$\{maxPositions\} - Occupied Positions\)`;/,
  );

  for (const heading of [
    "1. Investment philosophy",
    "2. Stage 2 universe",
    "3. Eligibility",
    "4. Ranking",
    "5. Existing-position treatment",
    "6. New-position treatment",
    "7. Execution sequence",
    "8. Formula",
    "9. Side selection",
    "10. Safety overlays",
    "11. Worked example",
  ]) {
    assert.match(dialogSource, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("Stage 2 to Stage 3 strategy metadata falls back safely for historical runs without the new policy payload", async () => {
  const {
    DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MAX_POSITIONS,
    DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MIN_LLM_SIDE_ODDS,
    readBullpenStage2To3StrategyMetadata,
    readBullpenStage2UniverseStatus,
  } = await loadStrategyModule();

  assert.deepEqual(readBullpenStage2To3StrategyMetadata(null), {
    minLlmSideOdds: DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MIN_LLM_SIDE_ODDS,
    maxPositions: DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MAX_POSITIONS,
    rankingField: "returns_per_day",
    rankingTieBreak: "market_id",
    sizingFormula: "cash_in_hand / (max_positions - occupied_positions)",
  });

  assert.deepEqual(readBullpenStage2UniverseStatus(null), {
    totalEligibleRows: null,
    reviewedRows: null,
    skippedRows: null,
    isComplete: true,
    blockerCode: null,
    blockerSummary: null,
    blockerFix: null,
  });

  assert.deepEqual(
    readBullpenStage2UniverseStatus({
      stage2_eligible_rows_total: 10,
      stage2_reviewed_rows: 8,
    }),
    {
      totalEligibleRows: 10,
      reviewedRows: 8,
      skippedRows: null,
      isComplete: false,
      blockerCode: null,
      blockerSummary: null,
      blockerFix: null,
    },
  );

  assert.deepEqual(
    readBullpenStage2UniverseStatus({
      stage2_eligible_rows_total: 10,
      stage2_reviewed_rows: 10,
      stage2_universe_complete: false,
    }),
    {
      totalEligibleRows: 10,
      reviewedRows: 10,
      skippedRows: null,
      isComplete: true,
      blockerCode: null,
      blockerSummary: null,
      blockerFix: null,
    },
  );

  assert.deepEqual(
    readBullpenStage2UniverseStatus({
      stage2_universe_status: {
        total_eligible_rows: 26,
        reviewed_rows: 20,
        skipped_rows: 6,
        is_complete: false,
        blocker_code: "manual_reuse_missing_active_positions",
        blocker_summary:
          "Saved LLM reuse missed 6 live active Bullpen rows that were not present in the saved table.",
        blocker_fix:
          "Rerun Stage 2 without reuse, or refresh the Bullpen x AI table so every live active position has a saved row.",
      },
    }),
    {
      totalEligibleRows: 26,
      reviewedRows: 20,
      skippedRows: 6,
      isComplete: false,
      blockerCode: "manual_reuse_missing_active_positions",
      blockerSummary:
        "Saved LLM reuse missed 6 live active Bullpen rows that were not present in the saved table.",
      blockerFix:
        "Rerun Stage 2 without reuse, or refresh the Bullpen x AI table so every live active position has a saved row.",
    },
  );
});

test("Stage 3 explanation copy no longer claims fixed Stage 3 sizing or extra disagreement blockers", () => {
  const sectionSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenInvestmentsSection.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const mathDialogSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenInvestmentMathDialog.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const strategySource = readFileSync(
    new URL("../lib/bullpenStage2To3Strategy.ts", import.meta.url),
    "utf8",
  );

  assert.match(sectionSource, /complete universe review/);
  assert.match(sectionSource, /combined top-10 ranking/);
  assert.match(sectionSource, /active or pending/);
  assert.match(sectionSource, /fresh post-exit cash/);
  assert.match(sectionSource, /including exactly/);

  assert.match(
    mathDialogSource,
    /automatic Stage 3 buys are re-sized after Event Exits using fresh cash and occupied-slot counts/,
  );
  assert.match(
    mathDialogSource,
    /formatBullpenStage2To3SizingFormulaLabel\(/,
  );
  assert.match(
    strategySource,
    /return `Cash in Hand \/ \(\$\{maxPositions\} - Occupied Positions\)`;/,
  );
  assert.doesNotMatch(mathDialogSource, /qualified rows receive a fixed \$5 buy amount/i);
});
