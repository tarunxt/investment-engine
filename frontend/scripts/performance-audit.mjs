import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

import { chromium, devices } from "playwright";
import { encode } from "next-auth/jwt";

const BASE_URL = (process.env.PERF_BASE_URL || "https://cred-x.in").replace(
  /\/+$/,
  "",
);
const OUTPUT_JSON = resolve(
  process.cwd(),
  process.env.PERF_OUTPUT_JSON ||
    "../performance-results/runtime-performance.json",
);
const OUTPUT_MARKDOWN = OUTPUT_JSON.replace(/\.json$/i, ".md");
const EMAIL = process.env.PERF_TEST_EMAIL;
const PASSWORD = process.env.PERF_TEST_PASSWORD;
const SYNTHETIC_AUTH_SECRET = process.env.PERF_LOCAL_AUTH_SECRET;
const MOCK_API = process.env.PERF_MOCK_API === "true";
const NAVIGATION_ONLY = process.env.PERF_NAVIGATION_ONLY === "true";
const RUNS = Math.max(
  1,
  Math.min(10, Number.parseInt(process.env.PERF_RUNS || "3", 10) || 3),
);

const PROFILES = {
  desktop: {
    context: {
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
    },
    throttle: null,
  },
  "throttled-mobile": {
    context: {
      ...devices["Moto G4"],
    },
    throttle: {
      cpuRate: 4,
      latencyMs: 150,
      downloadBytesPerSecond: Math.floor((1.6 * 1024 * 1024) / 8),
      uploadBytesPerSecond: Math.floor((750 * 1024) / 8),
    },
  },
};

const TARGETS = {
  login: {
    path: "/login",
    usableSelector: 'form input[name="email"], form input[type="email"]',
    authenticated: false,
  },
  dashboard: {
    path: "/console/dashboard",
    usableSelector: "main h1",
    meaningfulSelector: '[data-performance-usable="dashboard-summary"]',
    authenticated: true,
  },
  bullpen: {
    path: "/console/bullpen-ai",
    usableSelector: "main h1",
    meaningfulSelector: '[data-performance-usable="bullpen-runtime"]',
    authenticated: true,
  },
};

function round(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 100) / 100
    : null;
}

function percentile(values, fraction) {
  const finite = values
    .filter((value) => typeof value === "number" && Number.isFinite(value))
    .sort((left, right) => left - right);
  if (finite.length === 0) return null;
  const index = Math.max(
    0,
    Math.min(finite.length - 1, Math.ceil(finite.length * fraction) - 1),
  );
  return round(finite[index]);
}

function summarizeSamples(samples) {
  const metricNames = [
    "dnsMs",
    "connectionMs",
    "tlsMs",
    "ttfbMs",
    "domContentLoadedMs",
    "loadMs",
    "fcpMs",
    "lcpMs",
    "cls",
    "inpMs",
    "tbtMs",
    "usableMs",
    "meaningfulUsableMs",
    "criticalApiCompleteMs",
    "hydrationToUsableMs",
    "jsTransferBytes",
    "jsDecodedBytes",
    "cssTransferBytes",
    "cssDecodedBytes",
    "requestCount",
    "apiRequestCount",
    "longTaskCount",
  ];
  return Object.fromEntries(
    metricNames.map((name) => [
      name,
      {
        median: percentile(
          samples.map((sample) => sample.metrics?.[name]),
          0.5,
        ),
        p75: percentile(
          samples.map((sample) => sample.metrics?.[name]),
          0.75,
        ),
      },
    ]),
  );
}

function isApiUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "api.cred-x.in" ||
      parsed.pathname.startsWith("/backend-api/") ||
      parsed.pathname.startsWith("/api/bullpen-ai") ||
      parsed.pathname.startsWith("/api/auth/")
    );
  } catch {
    return false;
  }
}

async function configureProfile(context) {
  await context.addInitScript(() => {
    globalThis.__credxPerformance = {
      cls: 0,
      lcp: 0,
      inp: 0,
      longTasks: [],
    };

    const state = globalThis.__credxPerformance;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.lcp = Math.max(state.lcp, entry.startTime);
        }
      }).observe({ type: "largest-contentful-paint", buffered: true });
    } catch {}

    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) state.cls += entry.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch {}

    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.interactionId) {
            state.inp = Math.max(state.inp, entry.duration);
          }
        }
      }).observe({
        type: "event",
        buffered: true,
        durationThreshold: 16,
      });
    } catch {}

    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
          });
        }
      }).observe({ type: "longtask", buffered: true });
    } catch {}
  });

}

function dashboardSummaryFixture() {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    generated_at: now,
    usd_inr_rate: 83.5,
    usd_inr_source: "bounded-fallback",
    zerodha: {
      connected: true,
      login_time: now,
      expires_at: now,
      snapshot: {
        snapshot_date: now.slice(0, 10),
        captured_at: now,
        source: "performance-fixture",
        holdings_count: 2,
        holdings_market_value: 200_000,
        holdings_invested_value: 175_000,
        holdings_pnl: 25_000,
        holdings_day_change_value: 1_200,
        available_margin: 50_000,
        top_holdings: [
          {
            symbol: "FIXTURE-A",
            current_value: 120_000,
            invested_value: 100_000,
            pnl: 20_000,
            pnl_percent: 20,
            weight_percent: 60,
          },
          {
            symbol: "FIXTURE-B",
            current_value: 80_000,
            invested_value: 75_000,
            pnl: 5_000,
            pnl_percent: 6.67,
            weight_percent: 40,
          },
        ],
        history: [
          { captured_at: "2026-07-24T00:00:00Z", value: 195_000 },
          { captured_at: "2026-07-25T00:00:00Z", value: 198_000 },
          { captured_at: now, value: 200_000 },
        ],
      },
    },
    indmoney_us: {
      snapshot: {
        snapshot_date: now.slice(0, 10),
        captured_at: now,
        source: "performance-fixture",
        parse_status: "completed",
        holdings_count: 1,
        wallet_balance: 100,
        current_value: 2_000,
        invested_value: 1_750,
        day_return_value: 20,
        day_return_percent: 1,
        total_return_value: 250,
        total_return_percent: 14.29,
        top_holdings: [
          {
            symbol: "FIXTURE-US",
            current_value: 2_000,
            invested_value: 1_750,
            pnl: 250,
            pnl_percent: 14.29,
            weight_percent: 100,
          },
        ],
        history: [
          { captured_at: "2026-07-25T00:00:00Z", value: 1_980 },
          { captured_at: now, value: 2_000 },
        ],
      },
    },
    bullpen: {
      active_count: 0,
      claimable_count: 0,
      claimable_value: 0,
      cash_balance: 100,
      total_value: 100,
      unrealized_pnl: 0,
      wallet_value: 100,
      fetched_at: now,
      source: "redis-cache",
    },
    sections: {
      zerodha: { status: "ok", duration_ms: 4, fresh_at: now },
      indmoney_us: { status: "ok", duration_ms: 4, fresh_at: now },
      bullpen: { status: "ok", duration_ms: 2, fresh_at: now },
    },
  };
}

function legacyDashboardFixture(pathname) {
  const now = new Date().toISOString();
  if (pathname.endsWith("/zerodha/status")) {
    return { connected: true, login_time: now, expires_at: now };
  }
  if (pathname.endsWith("/zerodha/portfolio/overview")) {
    return {
      latest: {
        snapshot_date: now.slice(0, 10),
        captured_at: now,
        source: "performance-fixture",
        holdings_count: 0,
        net_positions_count: 0,
        day_positions_count: 0,
        holdings_market_value: 200_000,
        holdings_pnl: 25_000,
        holdings_day_change_value: 1_200,
        available_margin: 50_000,
        positions_pnl: 0,
        positions_m2m: 0,
        holdings: [],
        positions: { net: [], day: [] },
      },
      history: [],
    };
  }
  if (pathname.endsWith("/indmoney-us/portfolio/overview")) {
    return {
      latest: {
        id: 1,
        snapshot_date: now.slice(0, 10),
        captured_at: now,
        source: "performance-fixture",
        parse_status: "completed",
        parse_warnings: [],
        holdings_count: 0,
        reported_holdings_count: 0,
        indices_count: 0,
        wallet_balance: 100,
        current_value: 2_000,
        invested_value: 1_750,
        day_return_value: 20,
        day_return_percent: 1,
        total_return_value: 250,
        total_return_percent: 14.29,
        holdings: [],
        indices: [],
      },
      history: [],
    };
  }
  if (
    pathname.endsWith("/zerodha/threats/latest") ||
    pathname.endsWith("/indmoney-us/threats/latest")
  ) {
    return { analysis: null };
  }
  if (pathname.endsWith("/api-usage/summary")) {
    return { usd_inr_rate: 83.5 };
  }
  if (pathname.endsWith("/polymarket/state")) {
    return {
      status: "stopped",
      mode: "paper",
      live_trading_unlocked: false,
      updated_at: now,
      config: {},
      active_positions: [],
      recent_orders: [],
    };
  }
  return null;
}

async function installMockApi(page) {
  if (!MOCK_API) return;
  await page.route(
    (url) =>
      url.hostname === "api.cred-x.in" ||
      url.pathname.startsWith("/backend-api/") ||
      url.pathname.startsWith("/api/bullpen-ai"),
    async (route) => {
      const url = new URL(route.request().url());
      let payload = {};
      if (url.pathname.endsWith("/dashboard/summary")) {
        payload = dashboardSummaryFixture();
      } else if (url.pathname.startsWith("/api/bullpen-ai/positions")) {
        payload = {
          positions: [],
          summary: {
            activeCount: 0,
            claimableCount: 0,
            claimableValue: 0,
            cashBalance: 100,
            totalValue: 100,
            unrealizedPnl: 0,
            walletValue: 100,
          },
          fetchedAt: new Date().toISOString(),
          liveAvailable: true,
          positionsSource: "live-cli",
          health: null,
          lastSuccessfulLiveSnapshot: null,
          fallback: null,
        };
      } else {
        payload = legacyDashboardFixture(url.pathname) ?? {};
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          "cache-control": "private, no-cache",
          "server-timing": "fixture;dur=2",
          "x-correlation-id": "performance-fixture",
        },
        body: JSON.stringify(payload),
      });
    },
  );
}

async function configurePage(context, page, profile) {
  await installMockApi(page);
  if (!profile.throttle) return;
  const client = await context.newCDPSession(page);
  await client.send("Emulation.setCPUThrottlingRate", {
    rate: profile.throttle.cpuRate,
  });
  await client.send("Network.enable");
  await client.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: profile.throttle.latencyMs,
    downloadThroughput: profile.throttle.downloadBytesPerSecond,
    uploadThroughput: profile.throttle.uploadBytesPerSecond,
    connectionType: "cellular3g",
  });
}

async function createContext(browser, profile, storageState) {
  const context = await browser.newContext({
    ...profile.context,
    ...(storageState ? { storageState } : {}),
  });
  await configureProfile(context);
  return context;
}

async function obtainAuthenticatedStorageState(browser, profile) {
  if (SYNTHETIC_AUTH_SECRET) {
    const cookieName = "authjs.session-token";
    const nowSeconds = Math.floor(Date.now() / 1000);
    const userData = {
      id: 1,
      email: "performance-fixture@example.invalid",
      username: "performance-fixture",
      full_name: "Performance Fixture",
      role: "admin",
      is_active: true,
      is_verified: true,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      last_login: null,
      profile: null,
    };
    const value = await encode({
      secret: SYNTHETIC_AUTH_SECRET,
      salt: cookieName,
      token: {
        id: "1",
        sub: "1",
        email: userData.email,
        name: userData.full_name,
        username: userData.username,
        role: userData.role,
        accessToken: "performance-fixture-access-token",
        refreshToken: "performance-fixture-refresh-token",
        expiresIn: 3600,
        userData,
        iat: nowSeconds,
        exp: nowSeconds + 3600,
      },
    });
    return {
      cookies: [
        {
          name: cookieName,
          value,
          url: BASE_URL,
          httpOnly: true,
          secure: BASE_URL.startsWith("https://"),
          sameSite: "Lax",
          expires: nowSeconds + 3600,
        },
      ],
      origins: [],
    };
  }
  if (!EMAIL || !PASSWORD) return null;

  const context = await createContext(browser, profile, null);
  const page = await context.newPage();
  try {
    await configurePage(context, page, profile);
    await page.goto(`${BASE_URL}/login`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page.locator('input[type="email"]').fill(EMAIL);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await Promise.all([
      page.waitForURL(/\/console\//, { timeout: 45_000 }),
      page.locator('button[type="submit"]').click(),
    ]);
    return await context.storageState();
  } finally {
    await context.close();
  }
}

async function waitForUsable(page, selector) {
  const startedAt = await page.evaluate(() => performance.now());
  await page.locator(selector).first().waitFor({
    state: "visible",
    timeout: 30_000,
  });
  const endedAt = await page.evaluate(() => performance.now());
  return Math.max(startedAt, endedAt);
}

async function exerciseNonMutatingInteraction(page, targetName) {
  if (targetName === "login") {
    const input = page.locator('input[type="email"]').first();
    if (await input.isVisible().catch(() => false)) {
      await input.click();
      await input.press("Tab");
    }
    return;
  }

  const main = page.locator("main").first();
  if (await main.isVisible().catch(() => false)) {
    await main.click({ position: { x: 8, y: 8 } });
  }
}

async function collectPageMetrics(page, usableMs, apiResponses) {
  return page.evaluate(
    ({ usableAt, responseMetadata }) => {
      const navigation = performance.getEntriesByType("navigation")[0];
      const resources = performance.getEntriesByType("resource").map((entry) => ({
        name: entry.name,
        initiatorType: entry.initiatorType,
        startTimeMs: Math.round(entry.startTime * 100) / 100,
        durationMs: Math.round(entry.duration * 100) / 100,
        transferBytes: entry.transferSize,
        encodedBytes: entry.encodedBodySize,
        decodedBytes: entry.decodedBodySize,
      }));
      const state = globalThis.__credxPerformance || {
        cls: 0,
        lcp: 0,
        inp: 0,
        longTasks: [],
      };
      const fcp = performance
        .getEntriesByType("paint")
        .find((entry) => entry.name === "first-contentful-paint");
      const scripts = resources.filter(
        (entry) =>
          entry.initiatorType === "script" ||
          /\.m?js(?:\?|$)/i.test(new URL(entry.name).pathname),
      );
      const styles = resources.filter(
        (entry) =>
          entry.initiatorType === "css" ||
          /\.css(?:\?|$)/i.test(new URL(entry.name).pathname),
      );
      const apiResources = resources.filter((entry) => {
        const parsed = new URL(entry.name);
        return (
          parsed.hostname === "api.cred-x.in" ||
          parsed.pathname.startsWith("/backend-api/") ||
          parsed.pathname.startsWith("/api/bullpen-ai") ||
          parsed.pathname.startsWith("/api/auth/")
        );
      });
      const criticalApiResources = apiResources.filter(
        (entry) => !new URL(entry.name).pathname.startsWith("/api/auth/"),
      );
      const duplicateCounts = {};
      for (const entry of apiResources) {
        const parsed = new URL(entry.name);
        parsed.searchParams.sort();
        const key = `${entry.initiatorType}:${parsed.toString()}`;
        duplicateCounts[key] = (duplicateCounts[key] || 0) + 1;
      }
      const longTasks = state.longTasks || [];
      const totalBlockingTime = longTasks.reduce(
        (total, entry) => total + Math.max(0, entry.duration - 50),
        0,
      );

      return {
        metrics: {
          dnsMs: navigation
            ? navigation.domainLookupEnd - navigation.domainLookupStart
            : null,
          connectionMs: navigation
            ? navigation.connectEnd - navigation.connectStart
            : null,
          tlsMs:
            navigation && navigation.secureConnectionStart > 0
              ? navigation.connectEnd - navigation.secureConnectionStart
              : 0,
          ttfbMs: navigation
            ? navigation.responseStart - navigation.requestStart
            : null,
          domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? null,
          loadMs: navigation?.loadEventEnd ?? null,
          fcpMs: fcp?.startTime ?? null,
          lcpMs: state.lcp || null,
          cls: state.cls || 0,
          inpMs: state.inp || null,
          tbtMs: totalBlockingTime,
          usableMs: usableAt,
          meaningfulUsableMs: null,
          criticalApiCompleteMs:
            criticalApiResources.length > 0
              ? Math.max(
                  ...criticalApiResources.map(
                    (entry) => entry.startTimeMs + entry.durationMs,
                  ),
                )
              : null,
          hydrationToUsableMs: navigation
            ? Math.max(0, usableAt - navigation.domContentLoadedEventEnd)
            : null,
          jsTransferBytes: scripts.reduce(
            (total, entry) => total + entry.transferBytes,
            0,
          ),
          jsDecodedBytes: scripts.reduce(
            (total, entry) => total + entry.decodedBytes,
            0,
          ),
          cssTransferBytes: styles.reduce(
            (total, entry) => total + entry.transferBytes,
            0,
          ),
          cssDecodedBytes: styles.reduce(
            (total, entry) => total + entry.decodedBytes,
            0,
          ),
          requestCount: resources.length + 1,
          apiRequestCount: apiResources.length,
          longTaskCount: longTasks.length,
        },
        navigation: navigation
          ? {
              type: navigation.type,
              redirectCount: navigation.redirectCount,
              transferBytes: navigation.transferSize,
              encodedBytes: navigation.encodedBodySize,
              decodedBytes: navigation.decodedBodySize,
            }
          : null,
        resources,
        apiWaterfall: apiResources.map((resource) => ({
          ...resource,
          response:
            responseMetadata.find((response) => response.url === resource.name) ||
            null,
        })),
        duplicatedApiRequests: Object.entries(duplicateCounts)
          .filter(([, count]) => count > 1)
          .map(([url, count]) => ({ url, count })),
        longTasks,
      };
    },
    { usableAt: usableMs, responseMetadata: apiResponses },
  );
}

async function measureTarget(context, profile, targetName, target, visit) {
  const page = await context.newPage();
  const apiResponses = [];
  const pendingResponseReads = [];

  page.on("response", (response) => {
    if (!isApiUrl(response.url())) return;
    const headers = response.headers();
    const promise = response
      .body()
      .then((body) => {
        apiResponses.push({
          url: response.url(),
          status: response.status(),
          bodyBytes: body.byteLength,
          contentLength: Number.parseInt(headers["content-length"] || "", 10) || null,
          contentEncoding: headers["content-encoding"] || null,
          serverTiming: headers["server-timing"] || null,
          correlationIdPresent: Boolean(headers["x-correlation-id"]),
        });
      })
      .catch(() => {});
    pendingResponseReads.push(promise);
  });

  try {
    await configurePage(context, page, profile);
    const response = await page.goto(`${BASE_URL}${target.path}`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    const usableMs = await waitForUsable(page, target.usableSelector);
    let meaningfulUsableMs = null;
    if (target.meaningfulSelector) {
      const appeared = await page
        .locator(target.meaningfulSelector)
        .first()
        .waitFor({ state: "attached", timeout: 8_000 })
        .then(() => true)
        .catch(() => false);
      if (appeared) {
        meaningfulUsableMs = await page.evaluate(() => performance.now());
      }
    }
    await exerciseNonMutatingInteraction(page, targetName);
    await page.waitForTimeout(50);
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    await Promise.allSettled(pendingResponseReads);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve())),
    );
    const collected = await collectPageMetrics(page, usableMs, apiResponses);
    collected.metrics.meaningfulUsableMs = meaningfulUsableMs;
    return {
      target: targetName,
      path: target.path,
      visit,
      finalUrl: page.url().replace(BASE_URL, ""),
      documentStatus: response?.status() ?? null,
      ...collected,
    };
  } catch (error) {
    return {
      target: targetName,
      path: target.path,
      visit,
      finalUrl: page.url().replace(BASE_URL, ""),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await page.close();
  }
}

async function measureAuthenticatedNavigation(context, profile) {
  const page = await context.newPage();
  const openTradingBots = async () => {
    if ((await page.viewportSize())?.width < 1024) {
      await page.getByRole("button", { name: "Open navigation" }).click();
    }
    const tradingBots = page.getByRole("button", { name: "Trading Bots" });
    if (!(await page.locator('a[href="/console/bullpen-ai"]').isVisible())) {
      await tradingBots.click();
    }
    await page
      .locator('a[href="/console/bullpen-ai"]')
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
  };
  const navigateToBullpen = async () => {
    await openTradingBots();
    const startedAt = await page.evaluate(() => performance.now());
    await page.locator('a[href="/console/bullpen-ai"]').first().click();
    await page.waitForURL(/\/console\/bullpen-ai$/, { timeout: 30_000 });
    await page.locator("main h1").first().waitFor({
      state: "visible",
      timeout: 30_000,
    });
    const usableAt = await page.evaluate(() => performance.now());
    return round(usableAt - startedAt);
  };
  try {
    await configurePage(context, page, profile);
    await page.goto(`${BASE_URL}/console/dashboard`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page.locator("main h1").first().waitFor({ timeout: 30_000 });
    const firstUsableMs = await navigateToBullpen();

    await page.goBack({ waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/console\/dashboard$/, { timeout: 30_000 });
    await page.locator("main h1").first().waitFor({
      state: "visible",
      timeout: 30_000,
    });

    const warmUsableMs = await navigateToBullpen();
    return {
      from: "/console/dashboard",
      to: "/console/bullpen-ai",
      firstUsableMs,
      warmUsableMs,
    };
  } catch (error) {
    return {
      from: "/console/dashboard",
      to: "/console/bullpen-ai",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await page.close();
  }
}

async function measureWarmTarget(context, profile, targetName, target) {
  const samples = [];
  for (const visit of ["first", "repeat"]) {
    samples.push(
      await measureTarget(context, profile, targetName, target, visit),
    );
  }
  return samples;
}

function markdownReport(report) {
  const lines = [
    "# Cred-X runtime performance report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Base URL: ${report.baseUrl}`,
    "",
    `Authenticated coverage: ${report.authenticatedCoverage}`,
    "",
    "Values below are medians across equivalent runs. Byte values are transferred bytes reported by the browser.",
    "",
    "| Profile | Route | Visit | TTFB (ms) | FCP (ms) | LCP (ms) | TBT (ms) | Shell usable (ms) | Meaningful usable (ms) | Critical API complete (ms) | JS transfer | Requests | API requests |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const profile of report.profiles) {
    const groups = new Map();
    for (const sample of profile.samples) {
      if (!sample.metrics) continue;
      const key = `${sample.target}:${sample.visit}`;
      const values = groups.get(key) || [];
      values.push(sample);
      groups.set(key, values);
    }
    for (const [key, samples] of groups) {
      const [target, visit] = key.split(":");
      const summary = summarizeSamples(samples);
      lines.push(
        `| ${profile.name} | ${target} | ${visit} | ${summary.ttfbMs.median ?? "n/a"} | ${summary.fcpMs.median ?? "n/a"} | ${summary.lcpMs.median ?? "n/a"} | ${summary.tbtMs.median ?? "n/a"} | ${summary.usableMs.median ?? "n/a"} | ${summary.meaningfulUsableMs.median ?? "n/a"} | ${summary.criticalApiCompleteMs.median ?? "n/a"} | ${summary.jsTransferBytes.median ?? "n/a"} | ${summary.requestCount.median ?? "n/a"} | ${summary.apiRequestCount.median ?? "n/a"} |`,
      );
    }
  }

  lines.push("", "## Coverage notes", "");
  if (report.authenticatedCoverage === "skipped-missing-test-account-secret") {
    lines.push(
      "- Authenticated route and route-to-route navigation measurements were skipped because PERF_TEST_EMAIL and PERF_TEST_PASSWORD were not both set.",
    );
  }
  if (report.authenticatedCoverage === "complete-local-synthetic-session") {
    lines.push(
      "- Authenticated coverage used a local token fixture and intercepted compact API fixtures. No production credential, account data, external broker call, or mutation was used.",
    );
  }
  lines.push(
    "- The JSON companion contains DNS, connection, TLS, resource, API waterfall, response-size, duplicate-request, long-task, and percentile detail.",
    "",
  );
  return lines.join("\n");
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    runCount: RUNS,
    authenticatedCoverage:
      SYNTHETIC_AUTH_SECRET
        ? "complete-local-synthetic-session"
        : EMAIL && PASSWORD
          ? "complete"
          : "skipped-missing-test-account-secret",
    profiles: [],
  };

  try {
    for (const [profileName, profile] of Object.entries(PROFILES)) {
      const authenticatedStorageState =
        await obtainAuthenticatedStorageState(browser, profile);
      const profileResult = {
        name: profileName,
        throttle: profile.throttle,
        samples: [],
        navigation: [],
      };

      for (let run = 1; run <= RUNS; run += 1) {
        if (!NAVIGATION_ONLY) {
          for (const [targetName, target] of Object.entries(TARGETS)) {
            if (target.authenticated && !authenticatedStorageState) continue;
            const context = await createContext(
              browser,
              profile,
              target.authenticated ? authenticatedStorageState : null,
            );
            const samples = await measureWarmTarget(
              context,
              profile,
              targetName,
              target,
            );
            for (const sample of samples) {
              profileResult.samples.push({ run, ...sample });
            }
            await context.close();
          }
        }

        if (authenticatedStorageState) {
          const navigationContext = await createContext(
            browser,
            profile,
            authenticatedStorageState,
          );
          profileResult.navigation.push({
            run,
            ...(await measureAuthenticatedNavigation(navigationContext, profile)),
          });
          await navigationContext.close();
        }
      }

      profileResult.summary = Object.fromEntries(
        Object.entries(TARGETS)
          .filter(([, target]) => !target.authenticated || authenticatedStorageState)
          .flatMap(([targetName]) =>
            ["first", "repeat"].map((visit) => {
              const samples = profileResult.samples.filter(
                (sample) =>
                  sample.target === targetName && sample.visit === visit,
              );
              return [`${targetName}:${visit}`, summarizeSamples(samples)];
            }),
          ),
      );
      report.profiles.push(profileResult);
    }
  } finally {
    await browser.close();
  }

  await mkdir(dirname(OUTPUT_JSON), { recursive: true });
  await writeFile(OUTPUT_JSON, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(OUTPUT_MARKDOWN, markdownReport(report));
  console.log(`Performance JSON: ${OUTPUT_JSON}`);
  console.log(`Performance Markdown: ${OUTPUT_MARKDOWN}`);
  console.log(`Authenticated coverage: ${report.authenticatedCoverage}`);
}

await main();
