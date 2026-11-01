import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { outputAttribution } from "../lib/outputProvenance.ts";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../app/console/auto-rebalance-runs/_components/AutoRebalanceHistoryClient.tsx", import.meta.url), "utf8");
const jobSource = source.slice(source.indexOf("function JobDetails("), source.indexOf("export function AutoRebalanceHistoryDetailClient"));
const compiled = ts.transpileModule(jobSource, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
const JobDetails = new Function("require", "exports", "outputAttribution", "stageCardTone", "formatTime", "formatCost", "StatusBadge", `${compiled}; return JobDetails;`)(
  require, {}, outputAttribution, () => "", value => value || "Not available", value => String(value),
  ({ status }) => React.createElement("span", null, status),
);

const raw = "Model: Claude Sonnet 4.5 (Anthropic)\nSource date: 2026-10-08\nSynthetic holding: 2 shares, 123.45\n<script>unchanged</script>";
const fixture = (patch = {}) => ({
  id: 91, provider: "deepseek", model: "deepseek-v4-flash", status: "completed",
  prompt: "Synthetic prompt", response: raw,
  created_at: "2026-10-10T01:00:00Z", updated_at: "2026-10-10T02:00:00Z", ...patch,
});
const telemetry = (identities) => ({ source: "api_usage_attempt_events", identities,
  observed_from: "2026-10-10T01:15:00Z", observed_to: "2026-10-10T01:16:00Z" });

test("historical requested settings conflict does not invent actual execution identity", () => {
  const job = fixture();
  assert.deepEqual(outputAttribution(job), { header: raw.split("\n")[0], identities: [], conflict: true, comparison: "requested" });
  assert.equal(job.response, raw);
});

test("response telemetry takes priority over requested settings for header comparisons", () => {
  const identities = [{ provider: "anthropic", model: "claude-sonnet-4-5" }];
  assert.equal(outputAttribution(fixture({ output_provenance: telemetry(identities) })).conflict, false);
  assert.equal(outputAttribution(fixture({ output_provenance: telemetry([{ provider: "deepseek", model: null }]) })).conflict, true);
});

test("mixed repair identities, unknown names and ordinary prose are not falsely flagged", () => {
  const identities = [{ provider: "deepseek", model: "deepseek-v4-flash" }, { provider: "anthropic", model: "claude-sonnet-4-5" }];
  assert.equal(outputAttribution(fixture({ output_provenance: telemetry(identities) })).conflict, false);
  for (const response of ["Discuss Claude and DeepSeek", "Model: Synthetic unknown", "", null]) {
    assert.equal(outputAttribution(fixture({ response })).conflict, false);
  }
  assert.equal(outputAttribution(fixture({ response: "# **Model Used:** Claude Sonnet 4.5" })).conflict, true);
});

test("both markets share explicit time meanings and preserve escaped original text", () => {
  for (const market of ["india", "indmoney_us"]) {
    const html = renderToStaticMarkup(React.createElement(JobDetails, { job: fixture({ auto_rebalance_portfolio: market,
      output_provenance: telemetry([{ provider: "deepseek", model: "deepseek-v4-flash" }]) }) }));
    for (const text of ["Requested: deepseek / deepseek-v4-flash", "Provider-response telemetry:", "Attribution conflict:",
      "Job created:", "Job updated:", "Successful calls observed:", "Source date: 2026-10-08", "2026-10-10T01:15:00Z",
      "Synthetic holding: 2 shares, 123.45", "&lt;script&gt;unchanged&lt;/script&gt;", "unverified content"]) assert.ok(html.includes(text), text);
    assert.equal((html.match(/<details/g) || []).length, 1);
    assert.ok(html.includes("<summary"));
  }
});

test("failed, partial, interrupted, populated and verified-empty job output stay distinct", () => {
  for (const status of ["failed", "partial", "interrupted", "processing", "completed"]) {
    const html = renderToStaticMarkup(React.createElement(JobDetails, { job: fixture({ status, response: null,
      runtime_metadata_json: { synthetic: true }, output_provenance: telemetry([]) }) }));
    assert.ok(html.includes(status));
    assert.ok(html.includes("Execution identity unavailable"));
    assert.ok(html.includes("No model output was saved."));
    assert.ok(html.includes("Runtime metadata"));
    assert.equal((html.match(/<details/g) || []).length, 2);
    assert.equal(html.includes("Attribution conflict:"), false);
  }
});
