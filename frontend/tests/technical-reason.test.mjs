import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../lib/technicalReason.ts", import.meta.url), "utf8");
const exports = {};
new Function("exports", ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(exports);

test("saved technical errors retain dated factor details and show each repeated reason once per listing", () => {
  const unavailable = "Exact venue instrument unavailable";
  const detail = "Momentum: Missing session · 2026-11-09 · Trend: Missing session · 2026-11-09 · Trend: Missing session · 2026-11-10";
  const grouped = [unavailable, detail, unavailable].join(" · ");
  assert.deepEqual([grouped, grouped].map(exports.technicalReason), Array(2).fill(unavailable + " · " + detail));
});
