import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../lib/workflowStageModels.ts", import.meta.url), "utf8");
const exports = {};
new Function("exports", ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText)(exports);
const { resolveStageModelKeys } = exports;

test("new accounts select DeepSeek Flash with the requested stage multipliers", () => {
  for (const [stage, count] of Object.entries({ swing: 2, rebalance: 2, technical: 1, threats: 1 })) {
    assert.deepEqual(resolveStageModelKeys(stage, {}), Array(count).fill("deepseek::deepseek-v4-flash"));
  }
});

test("a saved stage replaces its default and keeps repeated calls and explicit clears", () => {
  const keys = ["provider::model-a", "provider::model-a", "provider::model-b"];
  const saved = { swing: keys, technical: [] };
  assert.deepEqual(resolveStageModelKeys("swing", saved), keys);
  assert.deepEqual(resolveStageModelKeys("technical", saved), []);
  assert.deepEqual(resolveStageModelKeys("rebalance", saved), Array(2).fill("deepseek::deepseek-v4-flash"));
});
