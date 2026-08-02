import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL(
    "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("scanned events dialog uses the authoritative total and explains missing rows", () => {
  assert.match(
    source,
    /All Events Scanned \(\{state\.totalScanned\}\)/,
  );
  assert.match(source, /No detailed event rows are available\./);
  assert.match(source, /retained aggregate scan counts only/);
  assert.match(source, /detailed rows have not been published yet/);
  assert.match(source, /events passed Stage 1 filters/);
});

test("scanned events dialog displays per-event filter reasons", () => {
  assert.match(source, />Reason<\/th>/);
  assert.match(source, /candidate\.filterReasons\.join\("; "\)/);
  assert.match(source, /Passed all Stage 1 filters\./);
});
