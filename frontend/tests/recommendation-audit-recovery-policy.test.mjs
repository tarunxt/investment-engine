import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as jsxRuntime from "react/jsx-runtime";

function harness(capabilities, current = true) {
  const slots = [], effects = [], requests = [];
  let cursor = 0, view = { capabilities, current: current ? { id: "current", run_id: 10, calculation: { findings: [] }, sizing: {}, coverage: {} } : null, previous: null, bundle_hash: "fixture", comparison: null, coverage: {} };
  const hooks = {
    useState(initial) { const index = cursor++; slots[index] ??= { value: initial }; return [slots[index].value, value => { slots[index].value = value; }]; },
    useRef(initial) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; },
    useEffect(fn, deps) {
      const index = cursor++, old = slots[index];
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
        old?.cleanup?.(); slots[index] = { deps }; effects.push(() => { slots[index].cleanup = fn(); });
      }
    },
  };
  const api = { comparison: async () => view, verify: async request => { requests.push(request); return { id: "fixture", status: "queued", spent_usd: "0", reserved_usd: "0", result: null }; } };
  const compiled = ts.transpileModule(readFileSync(new URL("../components/RecommendationAuditPanel.tsx", import.meta.url), "utf8"), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const compiledModule = { exports: {} };
  new Function("require", "exports", "setTimeout", "clearTimeout", compiled)(name => name === "react" ? hooks : name === "react/jsx-runtime" ? jsxRuntime : { recommendationAuditEnabled: true, recommendationAuditApi: api }, compiledModule.exports, () => 0, () => {});
  const render = async (runId = 10) => {
    let tree;
    for (let pass = 0; pass < 2; pass++) {
      cursor = 0; tree = compiledModule.exports.RecommendationAuditPanel({ runId, runCount: 1, formula: {}, market: "india", symbol: "FIXTUREEQ", exchange: "NSE", currentScore: 0, currentAction: "Hold" });
      effects.splice(0).forEach(fn => fn()); await new Promise(resolve => setImmediate(resolve));
    }
    return tree;
  };
  return { render, requests, setView(next) { view = { ...view, ...next }; }, close() { slots.forEach(slot => slot?.cleanup?.()); } };
}

function elements(tree) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(elements);
  return [tree, ...elements(tree.props?.children)];
}
const button = (tree, label) => elements(tree).find(node => node.type === "button" && node.props.children === label);

test("read-only recovery disables legacy capture, calculation and verification", async () => {
  for (const current of [false, true]) {
    const h = harness({ external_enabled: false, recovery_read_only: true }, current);
    try {
      const tree = await h.render();
      assert.equal(button(tree, "Capture current calculation").props.disabled, true);
      assert.equal(button(tree, current ? "Verify reversal" : "Capture legacy response as observed now").props.disabled, true);
    } finally { h.close(); }
  }
});

test("stored-only recovery keeps verification and cancellation available at zero budget", async () => {
  const h = harness({ external_enabled: false, recovery_read_only: false, recovery_stored_only: true });
  try {
    let tree = await h.render();
    assert.equal(button(tree, "Verify reversal").props.disabled, false);
    assert.equal(elements(tree).filter(node => node.type === "input").length, 0);
    await button(tree, "Verify reversal").props.onClick(); tree = await h.render();
    assert.equal(h.requests[0].mode, "stored_only"); assert.equal(h.requests[0].budget_usd, 0);
    assert.equal(button(tree, "Cancel verification").props.disabled, false);
    assert.ok(elements(tree).some(node => Array.isArray(node.props?.children) && node.props.children.includes(" · stored-only recovery enabled")));
  } finally { h.close(); }
});

test("a previously selected external checkbox cannot carry across a capability change", async () => {
  const h = harness({ external_enabled: true, recovery_read_only: false, daily_cap_usd: 1, kite_request_cost_usd: null });
  try {
    let tree = await h.render();
    elements(tree).find(node => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked: true } });
    h.setView({ capabilities: { external_enabled: false, recovery_read_only: false, recovery_stored_only: true } });
    tree = await h.render(11); await button(tree, "Verify reversal").props.onClick();
    assert.equal(h.requests[0].mode, "stored_only"); assert.equal(h.requests[0].budget_usd, 0);
  } finally { h.close(); }
});
