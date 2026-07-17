import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000";
const FIXTURE_PATH = "/dev/stage-two-llm-popup";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = path.resolve(__dirname, "../../artifacts/stage-two-popup");

mkdirSync(ARTIFACT_DIR, { recursive: true });

async function isVisibleWithinContainer(locator, container) {
  const elementHandle = await locator.elementHandle();
  const containerHandle = await container.elementHandle();
  if (!elementHandle || !containerHandle) return false;
  return elementHandle.evaluate((element, scrollContainer) => {
    const containerBox = scrollContainer.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return (
      box.width > 0 &&
      box.height > 0 &&
      box.left >= containerBox.left - 1 &&
      box.right <= containerBox.right + 1
    );
  }, containerHandle);
}

async function runViewportCheck(browser, viewport) {
  const page = await browser.newPage({ viewport });

  try {
    await page.goto(`${BASE_URL}${FIXTURE_PATH}`, {
      waitUntil: "domcontentloaded",
    });

    const mainSummary = page.getByTestId("fixture-main-events-summary");
    await mainSummary.waitFor({ state: "visible" });
    assert.match(await mainSummary.textContent(), /Events Summary/);
    assert.match(await mainSummary.textContent(), /LLM Odds/);
    assert.match(await mainSummary.textContent(), /Returns\/day/);
    assert.match(await mainSummary.textContent(), /Amount to be invested/);

    await mainSummary.screenshot({
      path: path.join(
        ARTIFACT_DIR,
        `main-events-summary-${viewport.width}x${viewport.height}.png`,
      ),
    });

    await page.getByTestId("open-run-a").click();

    const dialog = page.getByTestId("stage-two-llm-run-dialog");
    await dialog.waitFor({ state: "visible" });

    const dialogBody = page.getByTestId("stage-two-llm-run-dialog-body");
    const eventsSummary = page.getByTestId("stage-two-events-summary");
    const scrollContainer = eventsSummary.locator(".overflow-x-auto").first();
    const questionHeader = eventsSummary.getByText("Question", { exact: true });
    const amountHeader = eventsSummary.getByText("Amount to be invested");

    const dialogBounds = await dialog.boundingBox();
    assert.ok(dialogBounds, "Expected Stage 2 dialog bounds.");
    assert.ok(dialogBounds.x >= 0);
    assert.ok(dialogBounds.y >= 0);
    assert.ok(dialogBounds.x + dialogBounds.width <= viewport.width + 1);
    assert.ok(dialogBounds.y + dialogBounds.height <= viewport.height + 1);

    assert.equal(await scrollContainer.evaluate((element) => element.scrollLeft), 0);
    assert.equal(
      await isVisibleWithinContainer(questionHeader, scrollContainer),
      true,
    );

    const bodyScrollTop = await dialogBody.evaluate((element) => {
      element.scrollTop = 600;
      return element.scrollTop;
    });
    assert.ok(bodyScrollTop > 0);
    assert.equal(await page.evaluate(() => window.scrollY), 0);

    await dialog.screenshot({
      path: path.join(
        ARTIFACT_DIR,
        `stage-two-popup-left-${viewport.width}x${viewport.height}.png`,
      ),
    });

    const maxScrollLeft = await scrollContainer.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
      return element.scrollLeft;
    });
    assert.ok(maxScrollLeft > 0);
    assert.equal(
      await isVisibleWithinContainer(amountHeader, scrollContainer),
      true,
    );

    await dialog.screenshot({
      path: path.join(
        ARTIFACT_DIR,
        `stage-two-popup-right-${viewport.width}x${viewport.height}.png`,
      ),
    });

    await page.getByRole("button", { name: "Close LLM run details" }).click();
    await dialog.waitFor({ state: "hidden" });

    await page.getByTestId("open-run-b").click();
    const reopenedScrollContainer = page
      .getByTestId("stage-two-events-summary")
      .locator(".overflow-x-auto")
      .first();
    await page.getByTestId("stage-two-events-summary").waitFor({ state: "visible" });
    assert.equal(
      await reopenedScrollContainer.evaluate((element) => element.scrollLeft),
      0,
    );
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch({ headless: true });

try {
  for (const viewport of [
    { width: 1536, height: 1024 },
    { width: 1280, height: 800 },
  ]) {
    await runViewportCheck(browser, viewport);
  }
  console.log("Stage 2 popup browser checks passed.");
} finally {
  await browser.close();
}
