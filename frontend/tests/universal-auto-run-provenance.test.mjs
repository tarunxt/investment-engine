import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../app/console/trading-bots/_components/UniversalScanAutoRunCard.tsx", import.meta.url), "utf8");
const code = ts.transpileModule(source + "\nexport { requestStatus };", {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function load(status = null, error = null, fetch = undefined) {
  const values = [status, "", 360, null, error, "2026-10-04T10:00:00Z", true, false];
  let index = 0;
  const exports = {};
  vm.runInNewContext(code, { exports, fetch, require(name) {
    if (name === "react") return { ...React, useState: () => [values[index++], () => {}], useCallback: fn => fn, useEffect: () => {} };
    if (name === "lucide-react") return new Proxy({}, { get: () => () => null });
    return require(name);
  } });
  return exports;
}

function render(status, error) {
  return renderToStaticMarkup(load(status, error).UniversalScanAutoRunCard({}));
}

const empty = { history: [], last_failed_at: null, last_error: null };
const unavailable = { message: "Synthetic failed read", details: "Synthetic details" };

test("initial loading and failed reads never claim verified emptiness", () => {
  const loading = render(null, null);
  assert.match(loading, /Loading Universal Scan auto-run history/);
  assert.match(loading, /Loading failed-run status/);
  const failed = render(null, unavailable);
  assert.match(failed, /auto-run history unavailable/);
  assert.match(failed, /Failed-run status unavailable/);
  for (const html of [loading, failed]) {
    assert.doesNotMatch(html, /No Universal Scan auto-runs yet/);
    assert.doesNotMatch(html, /No failed Universal Scan auto-run/);
  }
});

test("successful empty reads retain their independent empty claims", () => {
  const html = render(empty, null);
  assert.match(html, /No Universal Scan auto-runs yet/);
  assert.match(html, /No failed Universal Scan auto-run/);
  assert.doesNotMatch(html, /could not be refreshed/);
});

test("failed refresh retains populated or empty history with freshness evidence", () => {
  const populated = { ...empty, history: [{ id: "synthetic-run", status: "completed", triggered_by: "scheduler", started_at: null, completed_at: null, total_events: 17, error: null }] };
  const html = render(populated, unavailable);
  assert.match(html, /17 events/);
  assert.match(html, /Showing the last successful status from/);
  assert.doesNotMatch(html, /No Universal Scan auto-runs yet/);
  assert.match(render(empty, unavailable), /No Universal Scan auto-runs yet/);
  assert.match(render(empty, unavailable), /current status could not be refreshed/);
});

test("failure timestamp without details does not imply no failed run", () => {
  const html = render({ ...empty, last_failed_at: "2026-10-04T10:00:00Z" }, null);
  assert.match(html, /Failure details unavailable/);
  assert.doesNotMatch(html, /No failed Universal Scan auto-run/);
});

test("partial responses cannot establish successful history or failure evidence", async () => {
  for (const payload of [{}, { history: [] }, { ...empty, history: null }, { ...empty, last_error: undefined }, { ...empty, last_failed_at: false }]) {
    const { requestStatus } = load(null, null, async () => ({ ok: true, json: async () => payload }));
    await assert.rejects(requestStatus(), /response is incomplete/);
  }
  const { requestStatus } = load(null, null, async () => ({ ok: true, json: async () => empty }));
  assert.equal(await requestStatus(), empty);
});

test("history and schedule share a source, independently loaded scan summaries do not invalidate it", () => {
  const backend = readFileSync(new URL("../../backend/app/domains/trading_bots/universal_scan.py", import.meta.url), "utf8");
  const statusFunction = backend.slice(backend.indexOf("def status_for_user"), backend.indexOf("def update_schedule"));
  assert.match(statusFunction, /return \{\*\*settings, \*\*state\}/);
  assert.match(backend, /"history": history\[:MAX_HISTORY\] if isinstance\(history, list\) else \[\]/);
  // A scan-summary failure is not an input to this status card. Its successful
  // history response remains authoritative, including a verified empty list.
  assert.doesNotMatch(source, /fetchUniversalSnapshot|universalSummary/);
  assert.match(render(empty, null), /No Universal Scan auto-runs yet/);
});
