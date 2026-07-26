#!/usr/bin/env node

import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { encode } from "next-auth/jwt";
import { chromium } from "playwright";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(scriptDirectory, "..");
const authSecret = "local-playwright-auth-hardening-secret";
const accessSentinel = "playwright-access-token-must-stay-server-only";
const refreshSentinel = "playwright-refresh-token-must-stay-server-only";

async function reservePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === "string") {
    throw new Error("Unable to reserve a Playwright port");
  }
  return address.port;
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Next.js exited before startup with ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/login`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the Playwright Next.js runtime");
}

async function sessionCookie(baseUrl, { expired = false } = {}) {
  const cookieName = "authjs.session-token";
  const now = Math.floor(Date.now() / 1_000);
  const userData = {
    id: 71,
    email: "playwright-auth@example.invalid",
    username: "playwright-auth",
    full_name: "Playwright Auth",
    role: "admin",
    is_active: true,
    is_verified: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    last_login: null,
    profile: null,
  };
  const expiresAt = expired ? now - 60 : now + 3_600;
  const value = await encode({
    secret: authSecret,
    salt: cookieName,
    token: {
      id: String(userData.id),
      sub: String(userData.id),
      email: userData.email,
      name: userData.full_name,
      username: userData.username,
      role: userData.role,
      accessToken: accessSentinel,
      refreshToken: refreshSentinel,
      expiresIn: 3_600,
      accessTokenExpiresAt: expiresAt * 1_000,
      sessionGeneration: expired ? "expired-generation" : "valid-generation",
      userData,
      iat: now - 60,
      exp: expiresAt,
    },
  });
  return {
    name: cookieName,
    value,
    url: baseUrl,
    httpOnly: true,
    sameSite: "Lax",
    secure: false,
    expires: expiresAt,
  };
}

async function authenticatedContext(browser, baseUrl, options) {
  return browser.newContext({
    storageState: {
      cookies: [await sessionCookie(baseUrl, options)],
      origins: [],
    },
  });
}

async function assertDelayedBootstrapDoesNotGateContent(browser, baseUrl) {
  const context = await authenticatedContext(browser, baseUrl);
  const page = await context.newPage();
  let sessionRequestCompleted = false;
  await page.route("**/api/auth/session", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await route.continue();
    sessionRequestCompleted = true;
  });

  const startedAt = performance.now();
  await page.goto(`${baseUrl}/console/dashboard`, {
    waitUntil: "domcontentloaded",
  });
  await page.locator('[data-console-shell="authenticated"]').waitFor();
  await page.locator('[data-performance-usable="dashboard-server-summary"]').waitFor();
  const visibleAt = performance.now() - startedAt;
  if (visibleAt > 1_500) {
    throw new Error(`Server-authenticated dashboard content took ${visibleAt}ms`);
  }
  if (sessionRequestCompleted) {
    throw new Error("Client session bootstrap completed before the delayed render assertion");
  }
  const html = await page.content();
  if (/Restoring your secure session/i.test(html)) {
    throw new Error("Authenticated children were replaced by the legacy restoration gate");
  }
  if (html.includes(accessSentinel) || html.includes(refreshSentinel)) {
    throw new Error("A server-only token appeared in rendered HTML/RSC content");
  }
  await page.unrouteAll({ behavior: "wait" });
  await context.close();
}

async function assertAuthFailureStates(browser, baseUrl) {
  const anonymous = await browser.newContext();
  const anonymousPage = await anonymous.newPage();
  await anonymousPage.goto(`${baseUrl}/console/dashboard`);
  if (!new URL(anonymousPage.url()).pathname.startsWith("/login")) {
    throw new Error("Unauthenticated console request did not redirect to login");
  }
  await anonymous.close();

  const expired = await authenticatedContext(browser, baseUrl, { expired: true });
  const expiredPage = await expired.newPage();
  await expiredPage.goto(`${baseUrl}/console/dashboard`);
  if (!new URL(expiredPage.url()).pathname.startsWith("/login")) {
    throw new Error("Expired Auth.js session did not redirect to login");
  }
  await expired.close();

  const failed = await authenticatedContext(browser, baseUrl);
  const failedPage = await failed.newPage();
  await failedPage.route("**/api/auth/session", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"error":"session unavailable"}',
    }),
  );
  await failedPage.goto(`${baseUrl}/console/dashboard`, {
    waitUntil: "domcontentloaded",
  });
  await failedPage.waitForTimeout(1_000);
  const failedHtml = await failedPage.content();
  if (/Restoring your secure session/i.test(failedHtml)) {
    throw new Error("Failed session endpoint caused an indefinite restoration screen");
  }
  const failedPath = new URL(failedPage.url()).pathname;
  const explicitState =
    failedPath.startsWith("/login") ||
    (await failedPage.locator('[data-console-shell="authenticated"]').count()) > 0;
  if (!explicitState) {
    throw new Error("Failed session endpoint produced neither recoverable content nor redirect");
  }
  await failed.close();
}

async function assertLazyRoutesDoNotLoadHiddenWork(browser, baseUrl) {
  const context = await authenticatedContext(browser, baseUrl);
  const page = await context.newPage();
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));

  await page.goto(`${baseUrl}/console/bullpen-ai`, {
    waitUntil: "networkidle",
  });
  await page.locator('[data-bullpen-workspace="unmounted"]').waitFor();
  if (
    requests.some((url) =>
      /api\/bullpen-ai\/(positions|current-odds)|polymarket\/auto-live/.test(url),
    )
  ) {
    throw new Error("Hidden Bullpen workspace fetched or polled before interaction");
  }
  const initialScripts = new Set(
    requests.filter((url) => url.includes("/_next/static/chunks/")),
  );
  await page.getByRole("button", { name: "Open live workspace" }).click();
  await page.locator('[data-bullpen-workspace="mounted"]').waitFor();
  await page.waitForTimeout(500);
  const postInteractionScripts = requests.filter(
    (url) =>
      url.includes("/_next/static/chunks/") && !initialScripts.has(url),
  );
  if (postInteractionScripts.length === 0) {
    throw new Error("Bullpen interaction did not load its isolated route chunk");
  }

  const dashboardPage = await context.newPage();
  const dashboardRequests = [];
  dashboardPage.on("request", (request) =>
    dashboardRequests.push(request.url()),
  );
  await dashboardPage.goto(`${baseUrl}/console/dashboard`, {
    waitUntil: "networkidle",
  });
  await dashboardPage.locator('[data-dashboard-analytics="unmounted"]').waitFor();
  const dashboardInitialScripts = new Set(
    dashboardRequests.filter((url) => url.includes("/_next/static/chunks/")),
  );
  await dashboardPage
    .getByRole("button", { name: "Open dashboard analytics" })
    .click();
  await dashboardPage.locator('[data-dashboard-analytics="mounted"]').waitFor();
  await dashboardPage.waitForTimeout(500);
  if (
    !dashboardRequests.some(
      (url) =>
        url.includes("/_next/static/chunks/") &&
        !dashboardInitialScripts.has(url),
    )
  ) {
    throw new Error("Dashboard interaction did not load its isolated analytics chunk");
  }

  await context.close();
}

async function main() {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [path.join(frontendRoot, "node_modules/next/dist/bin/next"), "start", "-p", String(port)],
    {
      cwd: frontendRoot,
      env: {
        ...process.env,
        NODE_ENV: "production",
        NEXTAUTH_SECRET: authSecret,
        AUTH_SECRET: authSecret,
        NEXTAUTH_URL: baseUrl,
        INTERNAL_API_URL: "http://127.0.0.1:1",
        NEXT_PUBLIC_API_URL: "http://127.0.0.1:1",
        NEXT_PUBLIC_DISABLE_AUTH: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  let browser;
  try {
    await waitForServer(baseUrl, child);
    browser = await chromium.launch({ headless: true });
    await assertDelayedBootstrapDoesNotGateContent(browser, baseUrl);
    await assertAuthFailureStates(browser, baseUrl);
    await assertLazyRoutesDoNotLoadHiddenWork(browser, baseUrl);
    console.log("Auth rendering and lazy-route Playwright checks passed");
  } catch (error) {
    if (output) console.error(output);
    throw error;
  } finally {
    await browser?.close();
    child.kill("SIGTERM");
  }
}

await main();
