import { readBullpenScheduleSource } from "./helpers/bullpenScheduleSource.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Bullpen auto-run login command uses the canonical investor HOME", () => {
  const source = readBullpenScheduleSource();

  assert.match(
    source,
    /const BULLPEN_LOGIN_COMMAND =\s*"sudo -u investor -H \/usr\/local\/bin\/bullpen login --no-browser"/,
  );
  assert.doesNotMatch(source, /HOME=\/var\/lib\/credx\/bullpen/);
});

test("historical auth text alone cannot render Login Needed", () => {
  const source = readBullpenScheduleSource();

  assert.match(
    source,
    /workflowRunHasHistoricalAuthError\s*&&\s*latestActiveAuthRequiresLogin/,
  );
  assert.match(source, /doctor_refresh_succeeded === false/);
  assert.match(source, /credentials_valid === false/);
  assert.match(source, /requires_login === true/);
  assert.match(source, /trade_auth_blocked === true/);
  assert.match(
    source,
    /Earlier Bullpen authentication error recovered; the latest\s+active doctor auth refresh is healthy\./,
  );
});
