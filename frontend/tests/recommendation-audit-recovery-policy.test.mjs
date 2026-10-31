import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as jsxRuntime from "react/jsx-runtime";

function harness(capabilities, current = true, overrides = {}) {
  const slots = [], effects = [], requests = [];
  let comparisonReads = 0;
  let cursor = 0, view = { capabilities, current: current ? { id: "current", run_id: 10, calculation: { findings: [] }, sizing: {}, coverage: {} } : null, previous: null, bundle_hash: "fixture", comparison: null, coverage: {} };
  const hooks = {
    useId() { const index = cursor++; slots[index] ??= { value: `audit-details-${index}` }; return slots[index].value; },
    useCallback(fn, deps) { const index = cursor++, old = slots[index]; if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) slots[index] = { deps, value: fn }; return slots[index].value; },
    useState(initial) { const index = cursor++; slots[index] ??= { value: initial }; return [slots[index].value, value => { slots[index].value = typeof value === "function" ? value(slots[index].value) : value; }]; },
    useRef(initial) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; },
    useEffect(fn, deps) {
      const index = cursor++, old = slots[index];
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
        old?.cleanup?.(); slots[index] = { deps }; effects.push(() => { slots[index].cleanup = fn(); });
      }
    },
  };
  const api = { comparison: async () => { comparisonReads++; return view; }, verify: async request => { requests.push(request); return { id: "fixture", status: "queued", spent_usd: "0", reserved_usd: "0", result: null }; }, ...overrides };
  const compiled = ts.transpileModule(readFileSync(new URL("../components/RecommendationAuditPanel.tsx", import.meta.url), "utf8"), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const compiledModule = { exports: {} };
  new Function("require", "exports", "setTimeout", "clearTimeout", compiled)(name => name === "react" ? hooks : name === "react/jsx-runtime" ? jsxRuntime : { recommendationAuditEnabled: true, recommendationAuditApi: api }, compiledModule.exports, () => 0, () => {});
  let sessionKey;
  const render = async (runId = 10, extra = {}) => {
    let tree;
    for (let pass = 0; pass < 2; pass++) {
      const session = compiledModule.exports.RecommendationAuditPanel({ runId, runCount: 1, formula: {}, market: "india", symbol: "FIXTUREEQ", exchange: "NSE", currentScore: 0, currentAction: "Hold", ...extra });
      if (session.key !== sessionKey) { slots.forEach(slot => slot?.cleanup?.()); slots.splice(0); effects.splice(0); sessionKey = session.key; }
      cursor = 0; tree = session.type(session.props);
      effects.splice(0).forEach(fn => fn()); await new Promise(resolve => setImmediate(resolve));
    }
    return tree;
  };
  return { render, requests, reads: () => comparisonReads, setView(next) { view = { ...view, ...next }; }, close() { slots.forEach(slot => slot?.cleanup?.()); } };
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
      assert.equal(button(tree, current ? "Verify stored evidence" : "Capture legacy response as observed now").props.disabled, true);
    } finally { h.close(); }
  }
});

test("stored-only recovery keeps verification and cancellation available at zero budget", async () => {
  const h = harness({ external_enabled: false, recovery_read_only: false, recovery_stored_only: true });
  try {
    let tree = await h.render();
    assert.equal(button(tree, "Verify stored evidence").props.disabled, false);
    assert.equal(elements(tree).filter(node => node.type === "input").length, 0);
    await button(tree, "Verify stored evidence").props.onClick(); tree = await h.render();
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
    tree = await h.render(11); await button(tree, "Verify stored evidence").props.onClick();
    assert.equal(h.requests[0].mode, "stored_only"); assert.equal(h.requests[0].budget_usd, 0);
  } finally { h.close(); }
});

test("a delayed verification cannot appear after the run or formula identity changes", async () => {
  let resolveVerification;
  const h = harness({ external_enabled: false, recovery_read_only: false }, true, {
    verify: () => new Promise(resolve => { resolveVerification = resolve; }),
  });
  try {
    const first = await h.render();
    const pending = button(first, "Verify stored evidence").props.onClick();
    await h.render(10, { formula: { actionScores: { Hold: 2 } }, currentScore: 2 });
    resolveVerification({ id: "old", status: "queued", result: null }); await pending;
    const current = await h.render(10, { formula: { actionScores: { Hold: 2 } }, currentScore: 2 });
    assert.equal(button(current, "Cancel verification"), undefined);
    assert.equal(button(current, "Verify stored evidence").props.disabled, false);
  } finally { h.close(); }
});

test("a missing capability response keeps capture and verification disabled", async () => {
  const h = harness(undefined);
  try { const tree = await h.render(); assert.equal(button(tree, "Capture current calculation").props.disabled, true); assert.equal(button(tree, "Verify stored evidence").props.disabled, true); }
  finally { h.close(); }
});


test("Verify Reversal starts collapsed and repeated toggles preserve controls, verification and request identity", async () => {
  const h = harness({ external_enabled: true, recovery_read_only: false, daily_cap_usd: 1 });
  try {
    let tree = await h.render();
    let toggle = elements(tree).find(node => node.props?.["aria-label"] === "Expand Verify Reversal");
    assert.equal(toggle.props["aria-expanded"], false);
    const id = toggle.props["aria-controls"];
    assert.equal(elements(tree).find(node => node.props?.id === id).props.hidden, true);
    const reads = h.reads();
    toggle.props.onClick(); tree = await h.render();
    assert.equal(elements(tree).find(node => node.props?.id === id).props.hidden, false);
    elements(tree).find(node => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked: true } });
    tree = await h.render();
    elements(tree).find(node => node.props?.["aria-label"] === "Verification spend cap in USD").props.onChange({ target: { value: "0.25" } });
    tree = await h.render();
    await button(tree, "Verify with independent API data").props.onClick(); tree = await h.render(); // mocked API only
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].budget_usd, 0.25);
    for (let i = 0; i < 3; i++) {
      elements(tree).find(node => node.props?.["aria-label"] === "Hide Verify Reversal").props.onClick(); tree = await h.render();
      assert.equal(elements(tree).find(node => node.props?.id === id).props.hidden, true);
      assert.equal(button(tree, "Cancel verification").props.disabled, false);
      elements(tree).find(node => node.props?.["aria-label"] === "Expand Verify Reversal").props.onClick(); tree = await h.render();
      assert.equal(elements(tree).find(node => node.props?.["aria-label"] === "Verification spend cap in USD").props.value, "0.25");
      assert.equal(elements(tree).find(node => node.type === "input" && node.props.type === "checkbox").props.checked, true);
      assert.equal(elements(tree).find(node => node.props?.id === id).props.hidden, false);
    }
    assert.equal(h.reads(), reads);
    assert.equal(h.requests.length, 1);
    tree = await h.render(11);
    assert.equal(elements(tree).find(node => node.props?.["aria-label"] === "Expand Verify Reversal").props["aria-expanded"], false);
  } finally { h.close(); }
});
