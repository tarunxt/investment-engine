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
  "@/hooks/useAuth": 'export const useAuth = () => ({user:{id:9001, role:"admin"}})',
  "@/hooks/useRebalanceCostQuote": 'export const fetchReferenceQuote = async () => ({rate:82,date:"2026-01-01",source:"Test reference"})',
  "@/services/api": 'export const apiService = {get:()=>window.readSource("fx"), zerodhaPortfolioOverview:()=>window.readSource("zerodha"), indmoneyUsPortfolioOverview:()=>window.readSource("indmoney")}',
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
  for (const state of ["success", "loading", "empty", "cached", "mixed", "enabled", "reference"]) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(`${origin}/?state=${state}`);
    const board = page.getByRole("main");
    const overview = page.getByRole("region", { name: "Portfolio overview table" });
    await overview.waitFor();
    if (state === "loading") await overview.getByText("Loading saved balances…").first().waitFor();
    else if (state === "empty") await overview.getByText("No saved balances available").first().waitFor();
    else if (state === "cached") {
      await overview.getByText("Refresh failed · Last-known values shown").waitFor();
      assert.ok((await overview.innerText()).includes("₹1,28,000"));
    } else {
      await overview.getByText("Saved snapshot available").first().waitFor();
      assert.ok((await overview.innerText()).includes("₹1,28,000"));
      if (state === "mixed") {
        await overview.getByText("Components have different capture times.").waitFor();
        assert.ok((await overview.innerText()).includes("Cash · $0"));
      }
      const total = {enabled:"₹2,26,280", success:"₹2,16,200", mixed:"₹2,12,000", reference:"₹2,14,100"}[state];
      await board.getByText(total, {exact:true}).waitFor();
      if (state === "reference") await board.getByText("Estimated INR", {exact:true}).waitFor();
      if (state === "success") {
        await page.getByRole("button",{name:"Hide investment numbers"}).click();
        assert.ok(!(await overview.innerText()).includes("1,28,000"));
        await page.getByRole("button",{name:"Show investment numbers"}).click();
        await page.evaluate(() => { window.fail = true; });
        await page.getByRole("button",{name:"Refresh Board"}).click();
        await overview.getByText("Refresh failed · Last-known values shown").first().waitFor();
        assert.ok((await overview.innerText()).includes("₹1,28,000"));
      }
    }
    for (const view of ["Overview","Sources and freshness","Refresh behaviour"]) {
      await page.getByRole("tab",{name:view,exact:true}).click();
      assert.equal(/Bullpen/.test(await board.innerText()), state === "enabled");
    }
    assert.equal((await page.evaluate(() => window.reads)).includes("bullpen"), state === "enabled");
    assert.equal(await board.locator("section").count(), 1);
    assert.deepEqual(errors, []);
    results.push({state,passed:true});
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
