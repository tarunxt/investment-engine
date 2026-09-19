const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(
  path.join(
    __dirname,
    "../app/console/trading-bots/_components/UniversalPolymarketScan.tsx",
  ),
  "utf8",
);

test("Scan Now queues the durable Universal worker", () => {
  assert.match(source, /body: JSON\.stringify\(\{ action: "run-now" \}\)/);
  assert.match(source, /onClick=\{\(\) => void queueScan\(\)\}/);
  assert.doesNotMatch(source, /fetch\(\`\/api\/bullpen-ai\?\$\{params\}\`/);
  assert.match(source, /disabled=\{scanActive\}/);
});
