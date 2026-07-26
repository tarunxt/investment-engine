import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function loadModule() {
  const source = readFileSync(
    new URL("../lib/privateDashboardCache.ts", import.meta.url),
    "utf8",
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loaded = { exports: {} };
  new Function("exports", "module", output)(loaded.exports, loaded);
  return loaded.exports;
}

function fakeStorage(initialKeys) {
  const values = new Map(initialKeys.map((key) => [key, "private"]));
  return {
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    keys() {
      return [...values.keys()];
    },
  };
}

test("logout/account cache purge removes private dashboard data only", () => {
  const { purgePrivateDashboardCache } = loadModule();
  const storage = fakeStorage([
    "investment-engine:dashboard-overview-cache:v3:user:1",
    "investment-engine:dashboard-overview-cache:v3:user:2",
    "investment-engine:dashboard:final-actionables:v1",
    "investment-engine:final-actionables:runs:india:india:v1",
    "investment-engine:rebalance-workflow-state:v1",
    "investment-engine:bullpen-ai:snapshots:v2",
    "investment-engine:bullpen-auto-run-status:v1:42",
    "bullpenAi.ec2Commands",
    "investment-engine:theme",
  ]);

  assert.equal(purgePrivateDashboardCache(storage), 8);
  assert.deepEqual(storage.keys(), ["investment-engine:theme"]);
});

test("cache owner changes purge global private caches before adoption", () => {
  const {
    reconcileBrowserPrivateCacheOwner,
    clearBrowserPrivateCacheOwner,
  } = loadModule();
  const values = new Map([
    ["investment-engine:private-cache-owner:v1", "1"],
    ["investment-engine:bullpen-ai:snapshots:v2", "private"],
  ]);
  const storage = {
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
  const previousWindow = globalThis.window;
  globalThis.window = { localStorage: storage, sessionStorage: storage };
  try {
    assert.equal(reconcileBrowserPrivateCacheOwner(2), true);
    assert.equal(
      values.has("investment-engine:bullpen-ai:snapshots:v2"),
      false,
    );
    assert.equal(values.get("investment-engine:private-cache-owner:v1"), "2");
    clearBrowserPrivateCacheOwner();
    assert.equal(values.has("investment-engine:private-cache-owner:v1"), false);
  } finally {
    globalThis.window = previousWindow;
  }
});
