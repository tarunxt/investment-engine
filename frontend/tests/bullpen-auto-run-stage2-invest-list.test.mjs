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
  assert.match(source, /Stage 2-ranked buy candidates that Stage 3 is trying to execute\./);
  assert.match(source, /If a top-ranked event was deferred, its latest blocker is shown/);
  assert.match(source, /Execution blocker \/ detail:/);
  assert.match(source, /decision\.stage3_result\?\.replaceAll\("_", " "\) \?\? "Pending"/);
});
