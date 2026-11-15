import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const trendsTable = readFileSync(
  new URL(
    "../app/console/bullpen-ai/_components/BullpenEventTrendsTable.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("History highlights only the invested side in current LLM odds for active positions", () => {
  assert.match(
    trendsTable,
    /event\.is_active_position \? event\.active_position_side\?\.trim\(\)\.toUpperCase\(\) : null/,
  );
  assert.match(trendsTable, /activePositionSide === "YES" \? activeSideClass : undefined/);
  assert.match(trendsTable, /activePositionSide === "NO" \? activeSideClass : undefined/);
  assert.match(trendsTable, /bg-emerald-100/);
  assert.match(trendsTable, /dark:bg-emerald-400\/20/);
});
