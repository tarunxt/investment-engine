import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("Bullpen Auto-Live console surfaces the latest failed run near the top of the page", () => {
  const autoLiveConsoleSource = readFileSync(
    new URL(
      "../app/console/trading-bots/bullpen-ai-auto-live/_components/BullpenAiAutoLiveConsole.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(autoLiveConsoleSource, /const latestRunFailureMessage =/);
  assert.match(autoLiveConsoleSource, /Latest Auto-Live run failed/);
  assert.match(
    autoLiveConsoleSource,
    /latestRun\.summary \|\| latestRun\.error_message \|\| state\.last_error/,
  );
});
