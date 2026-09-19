const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(
  path.join(__dirname, "../app/api/bullpen-ai/_lib/stageOneGammaExport.ts"),
  "utf8",
);

test("production frontend reads the backend worker's shared Universal exports", () => {
  assert.match(source, /process\.env\.APP_ROOT\?\.trim\(\)/);
  assert.match(
    source,
    /join\(DEPLOYED_APP_ROOT, "backend", "\.stage-one-exports"\)/,
  );
  assert.match(source, /BULLPEN_STAGE_ONE_EXPORT_DIRECTORY/);
  assert.match(source, /READABLE_EXPORT_DIRECTORIES/);
  assert.match(source, /\/srv\/investor\/backend\/\.stage-one-exports/);
  assert.match(source, /\/srv\/investment-engine\/backend\/\.stage-one-exports/);
  assert.match(source, /findReadableMetadata/);
  assert.match(source, /located\.directory/);
});
