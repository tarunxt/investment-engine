import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Bullpen auto-run login command uses the systemd Bullpen credential home", () => {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(
    source,
    /const BULLPEN_LOGIN_COMMAND =\s*"sudo -u investor env HOME=\/var\/lib\/credx\/bullpen BULLPEN_BIN=\/usr\/local\/bin\/bullpen \/usr\/local\/bin\/bullpen login --no-browser"/,
  );
  assert.doesNotMatch(source, /HOME=\/home\/investor/);
});
