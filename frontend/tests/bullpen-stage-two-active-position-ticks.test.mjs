import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const tableSource = readFileSync(new URL("../app/console/bullpen-ai/_components/BullpenQuestionsTable.tsx", import.meta.url), "utf8");
const scheduleSource = readFileSync(new URL("../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx", import.meta.url), "utf8");

test("Stage 2 Events Summary marks current active Bullpen positions with a large green tick", () => {
  assert.match(tableSource, /activePositionQuestionIds\?: ReadonlySet<string>/);
  assert.match(tableSource, /Current active Bullpen position/);
  assert.match(tableSource, /CheckCircle2 className="h-5 w-5 stroke-\[3\]"/);
  assert.match(scheduleSource, /function buildStageTwoActivePositionQuestionIds/);
  assert.match(scheduleSource, /buildBullpenEventIdentityFromPosition\(position\)/);
  assert.match(scheduleSource, /getIdentity: BullpenEventIdentityResolver\.fromQuestion/);
  assert.match(scheduleSource, /activePositionQuestionIds=\{activePositionQuestionIds\}/);
  assert.match(scheduleSource, /activePositions=\{activePositions\}/);
});
