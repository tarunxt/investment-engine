import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Polymarket bot EC2 commands persist edited and deleted defaults", () => {
  const source = readFileSync(
    new URL("../app/console/polymarket-bot/page.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /const EC2_COMMANDS_STORAGE_KEY = "polymarketBot\.ec2Commands"/);
  assert.match(
    source,
    /const DEFAULT_SYSTEMD_BULLPEN_LOGIN_COMMAND =\s*"sudo -u investor -H \/usr\/local\/bin\/bullpen login --no-browser"/,
  );
  assert.match(
    source,
    /const DEFAULT_SYSTEMD_BULLPEN_VERIFY_COMMAND =\s*"sudo -u investor -H \/usr\/local\/bin\/bullpen polymarket positions --output json"/,
  );
  assert.match(
    source,
    /return normalizeEc2Commands\(parsedCommands\) \?\? DEFAULT_EC2_COMMANDS;/,
  );
  assert.doesNotMatch(source, /Array\.from\(new Set\(\[\.\.\.DEFAULT_EC2_COMMANDS/);
  assert.match(source, /return current > index \? current - 1 : current;/);
});
