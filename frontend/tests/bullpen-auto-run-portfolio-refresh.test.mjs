import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL(
    "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("Bullpen auto-run completion refreshes the live portfolio snapshot once per run", () => {
  assert.match(
    source,
    /postCompletionPortfolioRefreshRunIdsRef\s*=\s*useRef<Set<string>>/,
  );
  assert.match(
    source,
    /postCompletionPortfolioRefreshRunIdsRef\.current\.has\(runId\)/,
  );
  assert.match(source, /await refreshPortfolioSnapshot\(true\)/);
});
