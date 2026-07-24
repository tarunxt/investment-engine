import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function read(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function assertTypeScriptParses(relativePath) {
  const source = read(relativePath);
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: relativePath,
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.deepEqual(
    errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    [],
  );
}

test("Bullpen API resolves and rotates the server Auth.js session", () => {
  const authSource = read("../auth.ts");
  const sessionSource = read(
    "../app/api/bullpen-ai/_lib/serverBackendSession.ts",
  );
  const authRouteSource = read("../app/api/auth/[...nextauth]/route.ts");

  assert.match(authSource, /export const \{ handlers, auth, unstable_update \}/);
  assert.match(authRouteSource, /import \{ handlers \} from "@\/auth"/);
  assert.match(sessionSource, /session\?\.accessToken/);
  assert.match(sessionSource, /request\.cookies\.get\("app_access_token"\)/);
  assert.match(sessionSource, /sessionAccessToken \|\| legacyAccessToken/);
  assert.match(sessionSource, /error\.status !== 401/);
  assert.match(sessionSource, /"\/auth\/refresh"/);
  assert.match(sessionSource, /await unstable_update\(\{ accessToken, refreshToken, expiresIn \}\)/);
  assert.match(sessionSource, /response\.cookies\.set\("app_access_token"/);
  assert.match(sessionSource, /response\.cookies\.set\("app_refresh_token"/);
});

test("Bullpen positions use one auth context and passive page-load reads", () => {
  const positionsSource = read("../app/api/bullpen-ai/positions/route.ts");

  assert.match(positionsSource, /createBackendSessionContext\(request\)/);
  assert.match(
    positionsSource,
    /loadTrackedPositionsFallback\(context: BackendSessionContext\)/,
  );
  assert.match(
    positionsSource,
    /fetchBackendJsonWithSession<PolymarketBotState>/,
  );
  assert.doesNotMatch(positionsSource, /new URL\("\/backend-api\/polymarket\/state"/);
  assert.match(positionsSource, /passiveValue === null\s*\? true/);
  assert.match(positionsSource, /forceFresh\s*\? false/);
  assert.match(positionsSource, /backendQuery\.set\("passive", "true"\)/);
});

test("Bullpen healthcheck systemd units are deployable", () => {
  const installer = read("../../deploy/no-docker/install-bullpen-healthcheck.sh");
  const service = read(
    "../../deploy/no-docker/systemd/credx-bullpen-healthcheck.service",
  );
  const timer = read(
    "../../deploy/no-docker/systemd/credx-bullpen-healthcheck.timer",
  );
  const workflow = read("../../.github/workflows/deploy.yml");

  assert.match(installer, /systemctl enable --now "\$TIMER_NAME"/);
  assert.match(service, /scripts\/bullpen-healthcheck\.ts/);
  assert.match(service, /EnvironmentFile=__FRONTEND_ENV_FILE__/);
  assert.match(timer, /OnUnitActiveSec=5min/);
  assert.match(workflow, /install-bullpen-healthcheck\.sh/);
});

test("changed Bullpen TypeScript files have no syntax diagnostics", () => {
  for (const relativePath of [
    "../auth.ts",
    "../app/api/auth/[...nextauth]/route.ts",
    "../app/api/bullpen-ai/_lib/backendBullpenRuntime.ts",
    "../app/api/bullpen-ai/_lib/serverBackendSession.ts",
    "../app/api/bullpen-ai/positions/route.ts",
  ]) {
    assertTypeScriptParses(relativePath);
  }
});
