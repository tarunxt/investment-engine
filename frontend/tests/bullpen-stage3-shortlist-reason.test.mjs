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

test("the Stage 3 shortlist explanation distinguishes saved decisions from threshold and ranking states", () => {
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
  assert.match(dialogSource, /no saved Stage 3 decision was found/i);
  assert.match(dialogSource, /DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MAX_POSITIONS/);
});
