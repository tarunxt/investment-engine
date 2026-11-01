// Isolated browser test of the real DashboardPageClient. No backend/provider access.
// Setup without changing project dependencies:
// npm install --prefix /tmp/credx-build --cache /tmp/credx-npm-cache esbuild@0.28.2
// DASHBOARD_ESBUILD_PATH=/tmp/credx-build/node_modules/esbuild node scripts/dashboard-freshness-playwright.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
const require = createRequire(import.meta.url);
const { build } = require(process.env.DASHBOARD_ESBUILD_PATH || "esbuild");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(
  process.env.DASHBOARD_EVIDENCE_DIR || "/tmp/credx-dashboard-evidence",
);
await mkdir(out, { recursive: true });
const fixture = await readFile(
  path.join(root, "scripts/fixtures/dashboard-freshness.tsx.txt"),
  "utf8",
);
const mocks = {
  "@/hooks/useAuth": "export const useAuth = () => ({user:{id:9001}})",
  "@/services/api":
    "export const apiService = {getDashboardSummary:()=>window.__summaryRead(),zerodhaThreatsLatest:()=>window.__threatRead(),indmoneyUsThreatsLatest:()=>window.__threatRead()}",
  "next/dynamic":
    'import React, {lazy,Suspense} from "react"; export default (load,options) => { const C=lazy(()=>load().then(component=>({default:component}))); return props=><Suspense fallback={options?.loading ? React.createElement(options.loading):null}><C {...props}/></Suspense> }',
  "next/link":
    'import React from "react"; export default ({children,prefetch,...props}) => <a {...props}>{children}</a>',
};
await build({
  stdin: {
    contents: fixture,
    resolveDir: path.join(root, "scripts/fixtures"),
    sourcefile: "fixture.tsx",
    loader: "tsx",
  },
  bundle: true,
  outfile: path.join(out, "fixture.js"),
  jsx: "automatic",
  plugins: [
    {
      name: "isolated-effects",
      setup(b) {
        b.onResolve({ filter: /.*/ }, (args) => {
          if (mocks[args.path]) return { path: args.path, namespace: "mock" };
          if (args.path.startsWith("@/"))
            return b.resolve(path.join(root, args.path.slice(2)), {
              resolveDir: root,
              kind: args.kind,
            });
        });
        b.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({
          contents: mocks[args.path],
          loader: "tsx",
          resolveDir: root,
        }));
      },
    },
  ],
});
const css = await postcss([tailwind({ base: root })]).process(
  await readFile(path.join(root, "app/globals.css"), "utf8"),
  { from: path.join(root, "app/globals.css") },
);
await writeFile(path.join(out, "fixture.css"), css.css);
const server = createServer(async (req, res) => {
  if (req.url === "/fixture.js" || req.url === "/fixture.css") {
    res.setHeader(
      "Content-Type",
      req.url.endsWith(".js") ? "text/javascript" : "text/css",
    );
    res.end(await readFile(path.join(out, req.url.slice(1))));
    return;
  }
  res.end(
    '<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body style="background:#f5f7fb;font-family:Arial,sans-serif"><main style="max-width:1280px;margin:auto;padding:28px" id="root"></main><script type="module" src="/fixture.js"></script></body></html>',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
const results = [];
try {
  for (const state of [
    "loading",
    "success",
    "empty",
    "failed",
    "stale-cache",
    "stale-response",
    "failed-retained-history",
    "partial-source",
    "missing-cash",
    "unavailable-fx",
    "deferred-panels",
    "loading-panels",
    "saved-panels",
    "cached-panels",
    "empty-panels",
    "failed-panels",
  ]) {
    const page = await browser.newPage({
      viewport: { width: 1180, height: 757 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/*", (route) =>
      route.request().url().startsWith(origin)
        ? route.continue()
        : route.abort(),
    );
    await page.goto(`${origin}/?state=${state}`);
    await page
      .getByRole("heading", { name: "Dashboard", exact: true })
      .waitFor();
    assert.equal(await page.evaluate(()=>devicePixelRatio),1);
    assert.equal(await page.evaluate(()=>visualViewport.scale),1);
    if (state === "loading") {
      await page.getByText("Loading…", { exact: true }).first().waitFor();
      await page
        .getByText("Loading saved Zerodha India snapshot…", { exact: true })
        .waitFor();
      await page
        .getByText("Loading saved INDmoney US snapshot…", { exact: true })
        .waitFor();
    } else if (state === "failed") {
      await page
        .getByText("Some dashboard modules could not be refreshed:", {
          exact: false,
        })
        .waitFor();
      await page
        .getByText("Refresh failed", { exact: false })
        .first()
        .waitFor();
    } else if (state === "stale-cache") {
      await page
        .getByText("Browser cache: 3h 0m old · Saved copy")
        .first()
        .waitFor();
      await page
        .getByText("Refresh failed", { exact: false })
        .first()
        .waitFor();
    } else if (state === "empty" || state === "missing-cash") {
      await page
        .getByText("Incomplete total", { exact: true })
        .first()
        .waitFor();
      await page
        .getByText("Combined INR unavailable", { exact: true })
        .waitFor();
    } else if (state === "partial-source") {
      await page
        .getByText("Refresh failed", { exact: false })
        .first()
        .waitFor();
      await page
        .getByText("Combined INR unavailable", { exact: true })
        .waitFor();
    } else if (state === "unavailable-fx") {
      await page
        .getByText("Combined INR unavailable", { exact: true })
        .waitFor();
      await page
        .getByText("USD/INR is unavailable;", { exact: false })
        .waitFor();
    } else {
      await page.getByText("All components available").first().waitFor();
      await page
        .getByText("Combined INR unavailable", { exact: true })
        .waitFor({ state: "hidden" });
    }
    if (state === "success") {
      const before = await page.evaluate(() => window.__reads);
      await page
        .getByRole("button", { name: "Refresh Board", exact: true })
        .click();
      await page.waitForFunction((n) => window.__reads > n, before);
      await page
        .getByRole("button", { name: "Refresh Board", exact: true })
        .isEnabled();
      await page
        .getByRole("tab", { name: "Refresh behaviour", exact: true })
        .click();
      await page
        .getByText("Refresh Board reloads stored portfolio snapshots", {
          exact: false,
        })
        .waitFor();
    }
    if (state === "success") {
      await page.getByRole("tab", { name: "Overview", exact: true }).click();
      assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1);
      assert.equal(
        await page
          .getByRole("rowheader", { name: "India", exact: false })
          .count(),
        1,
      );
      // Baseline scope: the eye controls summary values only; the independent history chart is unmasked.
      const summaryBalance = page.getByRole("region", {name:"Portfolio overview table", exact:true}).locator("tbody tr").first().locator("td p").first();
      const historyBalance = page.getByRole("region", {name:"Portfolio history", exact:true}).getByText("₹1,28,000",{exact:true});
      assert.match(await summaryBalance.innerText(), /\*/);
      assert.doesNotMatch(await summaryBalance.innerText(), /[0-9]/);
      assert.equal(await historyBalance.count(),1);
      await page.screenshot({path:path.join(out,"masking-scope-summary-hidden-1180.png"),fullPage:false});
      await page
        .getByRole("button", { name: "Show investment numbers", exact: true })
        .click();
      assert.equal(await summaryBalance.innerText(), "₹1,28,000");
      assert.equal(await historyBalance.count(),1);
      await page.screenshot({path:path.join(out,"masking-scope-summary-shown-1180.png"),fullPage:false});
      await page.getByRole("button",{name:"Hide investment numbers",exact:true}).click();
      assert.doesNotMatch(await summaryBalance.innerText(), /[0-9]/);
      assert.equal(await historyBalance.count(),1);
      await page.getByRole("button",{name:"Show investment numbers",exact:true}).click();
      await page
        .getByRole("tab", { name: "Sources and freshness", exact: true })
        .click();
      await page.getByText("Portfolio:", { exact: false }).first().waitFor();
      for (const source of ["India", "INDmoney", "Bullpen", "India"]) {
        const trigger = page.getByRole("button", {
          name: `${source} total (portfolio + cash) info`,
          exact: true,
        });
        await trigger.click();
        await page.getByRole("dialog").waitFor();
        await page.keyboard.press("Tab");
        assert.equal(
          await page
            .getByRole("dialog")
            .evaluate((el) => el.contains(document.activeElement)),
          true,
        );
        await page.keyboard.press("Escape");
        assert.equal(await page.getByRole("dialog").count(), 0);
        assert.equal(
          await trigger.evaluate((el) => el === document.activeElement),
          true,
        );
      }
      await page.evaluate(() => {
        window.__sourceEvents=[];
        for (const name of ["investment-engine:dashboard:zerodha-sync-now", "investment-engine:dashboard:indmoney-sync-now"]) window.addEventListener(name,()=>window.__sourceEvents.push(name));
        window.__sourceWalletReads=0;
        const originalFetch=window.fetch;
        window.fetch=(...args)=>{window.__sourceWalletReads++;return originalFetch(...args);};
      });
      for (const source of ["Zerodha", "INDmoney", "Bullpen"]) {
        await page.getByRole("button",{name:`Refresh ${source}`,exact:true}).focus();
        await page.keyboard.press("Enter");
      }
      assert.deepEqual(await page.evaluate(()=>window.__sourceEvents),["investment-engine:dashboard:zerodha-sync-now", "investment-engine:dashboard:indmoney-sync-now"]);
      await page.waitForFunction(()=>window.__sourceWalletReads > 0);
      const methodology=page.getByText("How portfolio totals are calculated",{exact:true});
      for (let cycle=0;cycle<2;cycle++) {
        await methodology.focus();
        await page.keyboard.press("Enter");
        assert.equal(await methodology.locator("..").getAttribute("open"), "");
        await page.keyboard.press("Enter");
        assert.equal(await methodology.locator("..").getAttribute("open"), null);
      }
      await page.screenshot({
        path: path.join(out, "sources-desktop.png"),
        fullPage: false,
      });
      await page
        .getByRole("tab", { name: "Sources and freshness", exact: true })
        .focus();
      await page.keyboard.press("ArrowRight");
      await page
        .getByRole("tabpanel", { name: "Refresh behaviour", exact: true })
        .waitFor();
      await page.screenshot({
        path: path.join(out, "refresh-desktop.png"),
        fullPage: false,
      });
      await page.getByRole("tab", { name: "Overview", exact: true }).click();
      assert.equal(
        await page
          .getByRole("button", { name: "Hide investment numbers", exact: true })
          .count(),
        1,
      );
      for (const width of [1180, 390]) {
        await page.setViewportSize({ width, height: 757 });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
          `overflow at ${width}`,
        );
        for (const view of [
          "Overview",
          "Sources and freshness",
          "Refresh behaviour",
        ]) {
          await page.getByRole("tab", { name: view, exact: true }).click();
          await page
            .getByRole("tabpanel", { name: view, exact: true })
            .waitFor();
          await page.screenshot({
            path: path.join(
              out,
              `${view.split(" ")[0].toLowerCase()}-${width}.png`,
            ),
            fullPage: false,
          });
        }
      }
      await page.setViewportSize({ width: 1180, height: 757 });
      await page.getByRole("tab", { name: "Overview", exact: true }).click();
    }
    // Residual repair: exact card guidance and chart sufficiency need verified reads too.
    if (state === "failed-retained-history") {
      await page.getByRole("img", {name:"All Time genuine India portfolio value history"}).waitFor();
      await page.getByRole("button", {name:"Refresh Board", exact:true}).click();
      await page.getByText("Cannot verify saved snapshot availability · Last-known snapshot shown", {exact:false}).first().waitFor();
      await page.getByRole("img", {name:"All Time genuine India portfolio value history"}).waitFor();
      await page.getByText("Holdings availability is unverified. View saved portfolio history.", {exact:true}).first().waitFor();
      await page.getByRole("button", {name:"1D", exact:true}).click();
      await page.locator('[data-portfolio-history-state="unknown"]').getByText("Cannot verify saved snapshot history for Past Day. History sufficiency is unknown; view saved portfolio history.", {exact:false}).waitFor();
    }
    if (["failed", "stale-cache", "partial-source", "failed-retained-history"].includes(state)) {
      assert.equal(await page.getByText("Paste an INDmoney US snapshot to surface allocations, return metrics, and threat signals on the dashboard.", {exact:true}).count(), 0);
      assert.equal(await page.getByText("Connect Zerodha and sync at least one snapshot to unlock India portfolio cards and threat prioritization here.", {exact:true}).count(), 0);
      if (state !== "failed-retained-history") {
        for (const key of (state === "partial-source" ? ["indmoney","combined"] : ["india","indmoney","bullpen","combined"])) {
          await page.getByRole("combobox", {name:"Choose portfolio chart"}).selectOption(key);
          await page.locator('[data-portfolio-history-state="unknown"]').getByText("Cannot verify saved snapshot history for All Time. History sufficiency is unknown; view saved portfolio history.", {exact:false}).waitFor();
          assert.equal(await page.getByText(/Insufficient genuine snapshot history/).count(), 0);
        }
        await page.getByRole("combobox", {name:"Choose portfolio chart"}).selectOption("india");
      }
    }
    if (state === "empty") {
      await page.getByText("Connect Zerodha and sync at least one snapshot to unlock India portfolio cards and threat prioritization here.", {exact:true}).waitFor();
      await page.getByText("Paste an INDmoney US snapshot to surface allocations, return metrics, and threat signals on the dashboard.", {exact:true}).waitFor();
      await page.locator('[data-portfolio-history-state="insufficient"]').getByText("Insufficient genuine snapshot history for All Time. The chart appears after at least 4 verified snapshots are available.", {exact:false}).waitFor();
    }
    // Trust repair: a failed or pending summary cannot establish absence in history.
    if (["loading", "success", "empty", "failed", "stale-cache", "stale-response", "partial-source"].includes(state)) {
      const overview = page.getByRole("region", {name:"Portfolio overview table", exact:true});
      const indiaRow = overview.getByRole("row").nth(1);
      const usRow = overview.getByRole("row").nth(2);
      const expected = state === "loading" ? "Checking saved snapshot availability"
        : state === "empty" ? "No saved snapshot returned by the latest successful read"
        : ["failed", "stale-cache"].includes(state) ? "Cannot verify saved snapshot availability"
        : "Saved snapshot available";
      await indiaRow.getByRole("status").getByText(expected, {exact:false}).waitFor();
      await usRow.getByRole("status").getByText(state === "partial-source" ? "Cannot verify saved snapshot availability" : expected, {exact:false}).waitFor();
      if (state === "stale-response") {
        await indiaRow.getByText("Snapshot: 720h 0m old", {exact:true}).waitFor();
        await usRow.getByText("Snapshot: 720h 0m old", {exact:true}).waitFor();
      }
      for (const [row, name, href] of [[indiaRow,"View India saved portfolio history","/console/zerodha#saved-portfolio-snapshots"], [usRow,"View US saved portfolio history","/console/indmoney-us#us-snapshot-panel-saved"]]) {
        const link = row.getByRole("link", {name, exact:true});
        assert.equal(await link.getAttribute("href"), href);
        await link.focus();
        assert.equal(await link.evaluate(el=>el === document.activeElement), true);
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        assert.equal(await link.evaluate(el=>el === document.activeElement), true);
        assert.equal(await row.getByRole("status").getAttribute("aria-live"), "polite");
      }
      if (["loading","failed","partial-source"].includes(state)) {
        assert.doesNotMatch(await overview.innerText(), /No snapshot available|No stored snapshot|No imported snapshot/);
      }
    }
    // Every primary availability state remains navigable in all mapped views.
    if (!state.endsWith("-panels")) {
      for (const width of [1180, 390]) {
        await page.setViewportSize({width, height:757});
        for (const view of ["Overview", "Sources and freshness", "Refresh behaviour"]) {
          await page.getByRole("tab", {name:view, exact:true}).click();
          await page.getByRole("tabpanel", {name:view, exact:true}).waitFor();
          assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true,`${state}/${view}: document overflow at ${width}`);
          const tabBounds = await page.getByRole("tablist",{name:"Portfolio overview details"}).boundingBox();
          const noticeBounds = await page.locator("[data-fx-status]").first().boundingBox();
          assert.ok(noticeBounds.y >= tabBounds.y + tabBounds.height, "tabs must not overlap currency notice");
          if (view !== "Refresh behaviour") {
            const table = page.getByRole("region", {name:view === "Overview" ? "Portfolio overview table" : "Sources and freshness table", exact:true});
            assert.equal(await table.getByRole("row").count(),4);
            if (width === 390) {
              await table.focus();
              await page.keyboard.press("ArrowRight");
              await page.waitForFunction(()=>Array.from(document.querySelectorAll('[role="region"]')).some(el=>el.scrollLeft > 0));
              await table.evaluate(el=>el.scrollLeft=el.scrollWidth);
              assert.equal(await table.evaluate(el=>el.scrollLeft + el.clientWidth >= el.scrollWidth - 1),true,"rightmost columns reachable");
              await table.evaluate(el=>el.scrollLeft=0);
            }
          }
          if (["loading","success","empty","failed","stale-cache","stale-response","failed-retained-history","partial-source","missing-cash","unavailable-fx"].includes(state)) {
            await page.screenshot({path:path.join(out,`${state}-${view.split(" ")[0].toLowerCase()}-${width}.png`),fullPage:false});
          }
        }
      }
      await page.setViewportSize({width:1180,height:757});
      await page.getByRole("tab", {name:"Overview", exact:true}).click();
    }
    if (state.endsWith("-panels")) {
      const deferred = page.getByText(
        "Not loaded yet · India Threat Pulse. Scroll to this panel to load the saved report.",
        { exact: true },
      );
      await deferred.waitFor();
      assert.equal(
        await page.evaluate(() => window.__threatReads),
        0,
        "deferred panels must not read reports early",
      );
      assert.equal(
        await deferred.locator("..").getAttribute("aria-busy"),
        "false",
      );
      if (state !== "deferred-panels") {
        await deferred.scrollIntoViewIfNeeded();
        await page.waitForFunction(() => window.__threatReads === 2);
        if (state === "cached-panels") {
          await page
            .getByText("Refreshing saved report…", { exact: true })
            .first()
            .waitFor();
          assert.equal(
            await page
              .getByText("Refreshing saved report…", { exact: true })
              .count(),
            2,
          );
          assert.equal(
            await page
              .getByText("Saved report loaded · See latest scan time below.", {
                exact: true,
              })
              .count(),
            0,
          );
        } else if (state === "loading-panels") {
          await page
            .getByText("Loading saved India Threat Pulse…", { exact: true })
            .waitFor();
          await page
            .getByText("Loading saved US Threat Pulse…", { exact: true })
            .waitFor();
        } else {
          const text =
            state === "saved-panels"
              ? "Saved report loaded · See latest scan time below."
              : state === "failed-panels"
                ? "Saved report read failed. Displayed data has not been refreshed."
                : "No saved report available.";
          await page.getByText(text, { exact: true }).first().waitFor();
          assert.equal(await page.getByText(text, { exact: true }).count(), 2);
          assert.equal(
            await page
              .getByText("Loading saved India Threat Pulse…", { exact: true })
              .count(),
            0,
          );
        }
      }
    }
    if (["failed", "empty", "failed-retained-history"].includes(state)) {
      for (const width of [1180, 390]) {
        await page.setViewportSize({width, height:757});
        for (const [market, title] of [["india", "Zerodha India"], ["us", "INDmoney US"]]) {
          const card = page.getByRole("heading", {name:title, exact:true}).locator("xpath=ancestor::section[1]");
          if (state !== "empty") assert.doesNotMatch(await card.innerText(), /Connect Zerodha and sync|Paste an INDmoney US snapshot|No holdings are available yet/);
          if (state === "failed" && market === "india") assert.doesNotMatch(await card.innerText(), /DISCONNECTED/i);
          await card.screenshot({path:path.join(out,`${state}-${market}-card-${width}.png`)});
        }
        const history = page.getByRole("region", {name:"Portfolio history", exact:true});
        await history.scrollIntoViewIfNeeded();
        await page.waitForTimeout(150);
        await history.screenshot({path:path.join(out,`${state}-history-${width}.png`)});
      }
      await page.setViewportSize({width:1180, height:757});
    }
    assert.deepEqual(errors, [], `${state}: browser runtime errors`);
    assert.equal(
      await page.evaluate(() => window.__unexpected.length),
      0,
      `${state}: unexpected external effects`,
    );
    await page.evaluate(() => window.scrollTo({top: 0, behavior: "instant"}));
    await page.screenshot({
      path: path.join(out, `${state}-desktop.png`),
      fullPage: false,
    });
    results.push({
      state,
      passed: true,
      reads: await page.evaluate(() => window.__reads),
      screenshot: `${state}-desktop.png`,
    });
    await page.close();
  }
  await writeFile(
    path.join(out, "results.json"),
    JSON.stringify(results, null, 2),
  );
  console.log(
    JSON.stringify({ passed: results.length, evidence: out, results }, null, 2),
  );
} finally {
  await browser.close();
  server.close();
}
