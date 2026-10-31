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
  "next/dynamic": 'import React, {lazy,Suspense} from "react"; export default (load,options) => { const C=lazy(()=>load().then(component=>({default:component}))); return props=><Suspense fallback={options?.loading ? React.createElement(options.loading):null}><C {...props}/></Suspense> }',
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
      viewport: { width: 1440, height: 1100 },
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
    if (state === "loading") {
      await page.getByText("Loading…", { exact: true }).first().waitFor();
      await page.getByText("Loading portfolio summary…", {exact:true}).waitFor();
      await page.getByText("Loading saved Zerodha India snapshot…", {exact:true}).waitFor();
      await page.getByText("Loading saved INDmoney US snapshot…", {exact:true}).waitFor();
    } else if (state === "failed") {
      await page
        .getByText("Some dashboard modules could not be refreshed:", {
          exact: false,
        })
        .waitFor();
      await page
        .getByText("Refresh failed", {exact:false})
        .first()
        .waitFor();
    } else if (state === "stale-cache") {
      await page
        .getByText("Browser cache: 3h 0m old · Saved copy")
        .first()
        .waitFor();
      await page
        .getByText("Refresh failed", {exact:false})
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
        .getByText("Refresh failed", {exact:false})
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
      assert.equal(
        await page
          .getByText("Combined INR unavailable", { exact: true })
          .count(),
        0,
      );
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
        .getByText("Refresh Board reloads stored portfolio snapshots", {
          exact: false,
        })
        .waitFor();
    }
    if (state.endsWith("-panels")) {
      const deferred = page.getByText("Not loaded yet · India Threat Pulse. Scroll to this panel to load the saved report.", {exact:true});
      await deferred.waitFor();
      assert.equal(await page.evaluate(()=>window.__threatReads),0,"deferred panels must not read reports early");
      assert.equal(await deferred.locator("..").getAttribute("aria-busy"),"false");
      if (state !== "deferred-panels") {
        await deferred.scrollIntoViewIfNeeded();
        await page.waitForFunction(()=>window.__threatReads===2);
        if (state === "cached-panels") {
          await page.getByText("Refreshing saved report…",{exact:true}).first().waitFor();
          assert.equal(await page.getByText("Refreshing saved report…",{exact:true}).count(),2);
          assert.equal(await page.getByText("Saved report loaded · See latest scan time below.",{exact:true}).count(),0);
        } else if (state === "loading-panels") {
          await page.getByText("Loading saved India Threat Pulse…",{exact:true}).waitFor();
          await page.getByText("Loading saved US Threat Pulse…",{exact:true}).waitFor();
        } else {
          const text=state === "saved-panels" ? "Saved report loaded · See latest scan time below." : state === "failed-panels" ? "Saved report read failed. Displayed data has not been refreshed." : "No saved report available.";
          await page.getByText(text,{exact:true}).first().waitFor();
          assert.equal(await page.getByText(text,{exact:true}).count(),2);
          assert.equal(await page.getByText("Loading saved India Threat Pulse…",{exact:true}).count(),0);
        }
      }
    }
    assert.deepEqual(errors, [], `${state}: browser runtime errors`);
    assert.equal(
      await page.evaluate(() => window.__unexpected.length),
      0,
      `${state}: unexpected external effects`,
    );
    await page.screenshot({
      path: path.join(out, `${state}-desktop.png`),
      fullPage: true,
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
