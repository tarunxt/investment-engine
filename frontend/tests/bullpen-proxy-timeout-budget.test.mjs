import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function read(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("Bullpen Auto-Live reads outlive the backend's four-second route deadline", () => {
  const proxySource = read("../app/backend-api/[...path]/route.ts");
  const backendSource = read(
    "../../backend/app/domains/polymarket_auto_live/router.py",
  );

  assert.match(backendSource, /DASHBOARD_SUMMARY_TIMEOUT_SECONDS = 4\.0/);
  assert.match(backendSource, /HISTORY_TIMEOUT_SECONDS = 4\.0/);
  assert.match(backendSource, /CONSOLE_RUN_DETAIL_TIMEOUT_SECONDS = 4\.0/);

  assert.match(
    proxySource,
    /DEFAULT_BULLPEN_BACKEND_PROXY_ATTEMPT_TIMEOUT_MS = 4_200/,
  );
  assert.match(
    proxySource,
    /DEFAULT_BULLPEN_BACKEND_PROXY_TOTAL_TIMEOUT_MS = 4_750/,
  );
  assert.match(proxySource, /path\.startsWith\("polymarket\/auto-live\/"\)/);
  assert.match(
    proxySource,
    /getProxyAttemptTimeoutMs\(request\.method, path\)/,
  );
  assert.match(proxySource, /getProxyTotalTimeoutMs\(request\.method, path\)/);
  assert.match(proxySource, /X-Backend-Proxy-Budget-Ms/);
});

test("ordinary API reads retain the strict fast-failure budget", () => {
  const proxySource = read("../app/backend-api/[...path]/route.ts");

  assert.match(proxySource, /DEFAULT_BACKEND_PROXY_ATTEMPT_TIMEOUT_MS = 1_200/);
  assert.match(proxySource, /DEFAULT_BACKEND_PROXY_TOTAL_TIMEOUT_MS = 4_000/);
});

test("the updated backend proxy route parses as TypeScript", () => {
  const source = read("../app/backend-api/[...path]/route.ts");
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "route.ts",
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );

  assert.deepEqual(
    errors.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    ),
    [],
  );
});
