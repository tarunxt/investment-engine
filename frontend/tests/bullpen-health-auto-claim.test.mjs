import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const FRONTEND_ROOT = path.resolve(process.cwd(), "frontend");
const BULLPEN_API_ROOT = path.join(FRONTEND_ROOT, "app", "api", "bullpen-ai");
const SOURCE_ROOTS = [
  path.join(FRONTEND_ROOT, "app"),
  path.join(FRONTEND_ROOT, "lib"),
];

function walkSourceFiles(rootDir) {
  const files = [];

  for (const entry of readdirSync(rootDir)) {
    const entryPath = path.join(rootDir, entry);
    const entryStat = statSync(entryPath);
    if (entryStat.isDirectory()) {
      files.push(...walkSourceFiles(entryPath));
      continue;
    }
    if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry)) {
      files.push(entryPath);
    }
  }

  return files;
}

test("frontend Bullpen routes proxy the backend runtime instead of spawning Bullpen locally", () => {
  const positionsRouteSource = readFileSync(
    path.join(BULLPEN_API_ROOT, "positions", "route.ts"),
    "utf8",
  );
  const healthRouteSource = readFileSync(
    path.join(BULLPEN_API_ROOT, "health", "route.ts"),
    "utf8",
  );
  const discoverRouteSource = readFileSync(
    path.join(BULLPEN_API_ROOT, "route.ts"),
    "utf8",
  );

  assert.match(positionsRouteSource, /fetchBackendRuntimeJson/);
  assert.match(positionsRouteSource, /\/polymarket\/runtime\/positions/);
  assert.match(healthRouteSource, /\/polymarket\/runtime\/health/);
  assert.match(discoverRouteSource, /\/polymarket\/runtime\/discover/);
  assert.doesNotMatch(positionsRouteSource, /syncBullpenLiveSnapshot/);
  assert.doesNotMatch(positionsRouteSource, /readLastSuccessfulBullpenLiveSnapshot/);
});

test("frontend source tree contains no Bullpen child_process or execFile runtime usage", () => {
  const sourceFiles = SOURCE_ROOTS.flatMap((rootDir) => walkSourceFiles(rootDir));
  const offenders = [];

  for (const sourceFile of sourceFiles) {
    const source = readFileSync(sourceFile, "utf8");
    if (/node:child_process/.test(source)) {
      offenders.push(`${sourceFile}: node:child_process import`);
    }
    if (/\bpromisify\s*\(\s*execFile\s*\)/.test(source)) {
      offenders.push(`${sourceFile}: promisify(execFile)`);
    }
    if (/\bexecFileAsync\s*\(/.test(source)) {
      offenders.push(`${sourceFile}: execFileAsync(...)`);
    }
  }

  assert.deepEqual(offenders, []);
});

test("legacy frontend Bullpen runtime helper was removed", () => {
  const legacyHelperPath = path.join(
    BULLPEN_API_ROOT,
    "_lib",
    "bullpenHealth.ts",
  );

  assert.throws(() => statSync(legacyHelperPath));
});
