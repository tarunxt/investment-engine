import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("each Bullpen event has an accessible Stage 3 shortlist explanation control", () => {
  const tableSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenQuestionsTable.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const dialogSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenStage3ShortlistReasonDialog.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(tableSource, /Explain Stage 3 shortlist status for/);
  assert.match(tableSource, /aria-haspopup="dialog"/);
  assert.match(tableSource, /BullpenStage3ShortlistReasonDialog/);
  assert.match(dialogSource, /role="dialog"/);
  assert.match(dialogSource, /aria-modal="true"/);
  assert.match(dialogSource, /event\.key === "Escape"/);
});

test("the Stage 3 shortlist explanation shows each eligibility check and distinguishes saved decisions from local eligibility", () => {
  const tableSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenQuestionsTable.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const dialogSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenStage3ShortlistReasonDialog.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(dialogSource, /Recorded Stage 3 decision/);
  assert.match(dialogSource, /below the required/);
  assert.match(dialogSource, /cannot rank it in the combined top-10 table/);
  assert.match(dialogSource, /Eligible for Stage 3/);
  assert.match(dialogSource, /Ranking pending\/failed/);
  assert.match(dialogSource, /Current Event Summary ranking places this event inside the top-10 shortlist/);
  assert.match(dialogSource, /currentTopTenQuestionIds\?\.has\(question\.id\)/);
  assert.match(tableSource, /currentTopTenQuestionIds=\{topTenStrongestLlmOddsIds\}/);
  assert.match(dialogSource, /stage3_final_rank/);
  assert.match(dialogSource, /i\) Strongest LLM odds ≥ 80%/);
  assert.match(dialogSource, /ii\) Inside Top 10/);
  assert.match(dialogSource, /iii\) No other Stage 3 errors/);
  assert.match(dialogSource, /CheckCircle2/);
  assert.match(dialogSource, /XCircle/);
  assert.match(dialogSource, /DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MAX_POSITIONS/);
});

test("the shortlist dialog prefers persisted run_id plus market_id matching over title or URL fallback", () => {
  const dialogSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenStage3ShortlistReasonDialog.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(dialogSource, /normalizeRunId\(question\.llmRunId\)/);
  assert.match(dialogSource, /decision\.run_id\) === normalizedRunId/);
  assert.match(dialogSource, /decision\.market_id\) === normalizedMarketId/);
  assert.doesNotMatch(dialogSource, /normalizeTitle/);
});

test("the Stage 3 shortlist explanation distinguishes eligibility from the final order outcome", () => {
  const dialogSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenStage3ShortlistReasonDialog.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(dialogSource, /Final Stage 3 outcome/);
  assert.match(dialogSource, /Not moved to Stage 3 yet/);
  assert.match(dialogSource, /Not finally moved to Stage 3/);
  assert.match(dialogSource, /Moved to Stage 3/);
  assert.match(dialogSource, /submitted.*confirmed/);
});
