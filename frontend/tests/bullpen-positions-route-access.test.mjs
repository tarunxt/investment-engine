import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("Bullpen UI positions use the authenticated display endpoint rather than the admin runtime endpoint", () => {
  const source = readFileSync(
    new URL("../app/api/bullpen-ai/positions/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /\/polymarket\/runtime\/positions\/display\?\$\{backendQuery\.toString\(\)\}/);
  assert.doesNotMatch(source, /`\/polymarket\/runtime\/positions\?\$\{backendQuery\.toString\(\)\}`/);
});
