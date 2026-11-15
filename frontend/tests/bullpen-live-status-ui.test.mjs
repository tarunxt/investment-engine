import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Bullpen positions dialog exposes live status, HOME, and last live refresh copy", () => {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenPositionsDialog.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /Live status/);
  assert.match(source, /Auth expired/);
  assert.match(source, /Network issue/);
  assert.match(source, /CLI missing/);
  assert.match(source, /Last successful live refresh/);
  assert.match(source, /Credential HOME/);
  assert.match(source, /Action needed/);
  assert.match(source, /Tracked fallback/);
});
