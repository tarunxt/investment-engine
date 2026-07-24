import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const frontendDirectory = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

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

test("latest threat responses hydrate a bounded history with one snapshot query", () => {
  const zerodhaSource = read("../../backend/app/domains/zerodha/threats_router.py");
  const indmoneySource = read("../../backend/app/domains/indmoney_us/threats_router.py");

  for (const source of [zerodhaSource, indmoneySource]) {
    assert.match(source, /THREAT_HISTORY_AUGMENTATION_LIMIT = 50/);
    assert.match(
      source,
      /\.order_by\(Job\.id\.desc\(\)\)\s*\.limit\(THREAT_HISTORY_AUGMENTATION_LIMIT\)/,
    );
    assert.match(source, /jobs\.reverse\(\)/);
  }

  assert.match(
    zerodhaSource,
    /ZerodhaPortfolioSnapshot\.snapshot_date\.in_\(tuple\(snapshot_dates\)\)/,
  );
  assert.doesNotMatch(zerodhaSource, /await snapshot_repo\.get_by_user_and_date/);

  assert.match(
    indmoneySource,
    /IndMoneyUsPortfolioSnapshot\.id\.in_\(tuple\(snapshot_ids\)\)/,
  );
  assert.doesNotMatch(indmoneySource, /await snapshot_repo\.get_by_user_and_id/);
});

test("structured Bullpen degradation stays readable by dashboard clients", () => {
  const sessionSource = read(
    "../app/api/bullpen-ai/_lib/serverBackendSession.ts",
  );

  assert.match(sessionSource, /isStructuredDegradedPositionsResponse/);
  assert.match(sessionSource, /upstreamStatus === 503/);
  assert.match(sessionSource, /\{ \.\.\.init, status: 200 \}/);
  assert.match(sessionSource, /X-CredX-Degraded/);
  assert.match(sessionSource, /X-CredX-Upstream-Status/);
  assertTypeScriptParses(
    "../app/api/bullpen-ai/_lib/serverBackendSession.ts",
  );
});

test("changed threat routers have valid Python syntax", () => {
  execFileSync(
    "python3",
    [
      "-m",
      "py_compile",
      "backend/app/domains/zerodha/threats_router.py",
      "backend/app/domains/indmoney_us/threats_router.py",
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PYTHONPYCACHEPREFIX: `${frontendDirectory}/.test-pycache`,
      },
      stdio: "pipe",
    },
  );
});
