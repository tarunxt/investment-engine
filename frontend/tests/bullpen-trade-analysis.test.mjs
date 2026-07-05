import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("Bullpen x AI page exposes the Analyse Events button and route helper", () => {
  const pageSource = readSource("../app/console/bullpen-ai/page.tsx");
  const urlsSource = readSource("../lib/urls.ts");

  assert.match(pageSource, /Analyse Events/);
  assert.match(
    pageSource,
    /href=\{URLs\.routes\.console\.bullpenAiAnalyseEvents\(\)\}/,
  );
  assert.match(
    urlsSource,
    /bullpenAiAnalyseEvents: \(\) => "\/console\/bullpen-ai\/analyse-events"/,
  );
  assert.match(
    urlsSource,
    /bullpenAiAnalyseEventDetail: \(tradeId: string\) =>\s*`\/console\/bullpen-ai\/analyse-events\/\$\{tradeId\}`/,
  );
});

test("Trade analysis list and detail pages stay wired to their client screens", () => {
  const listPageSource = readSource("../app/console/bullpen-ai/analyse-events/page.tsx");
  const detailPageSource = readSource(
    "../app/console/bullpen-ai/analyse-events/[tradeId]/page.tsx",
  );
  const listClientSource = readSource(
    "../app/console/bullpen-ai/analyse-events/_components/TradeAnalysisListClient.tsx",
  );
  const detailClientSource = readSource(
    "../app/console/bullpen-ai/analyse-events/_components/TradeAnalysisDetailClient.tsx",
  );

  assert.match(listPageSource, /TradeAnalysisListClient/);
  assert.match(detailPageSource, /TradeAnalysisDetailClient/);
  assert.match(listClientSource, /Bullpen Trade Analysis/);
  assert.match(listClientSource, /Learning Insights/);
  assert.match(detailClientSource, /Lifecycle Summary/);
  assert.match(detailClientSource, /Actionable Learning/);
  assert.match(detailClientSource, /Raw Data/);
});

test("Bullpen analysis requests carry analysis context from the selected question rows", () => {
  const pageSource = readSource("../app/console/bullpen-ai/page.tsx");

  assert.match(pageSource, /analysis_context:/);
  assert.match(pageSource, /volume_usd: parseBullpenNumericMetric\(question\.volume\)/);
  assert.match(pageSource, /liquidity_usd: parseBullpenNumericMetric\(question\.liquidity\)/);
  assert.match(pageSource, /preflight_evidence_block: question\.preflightEvidenceBlock \?\? null/);
});
