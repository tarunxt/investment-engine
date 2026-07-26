#!/usr/bin/env node

import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { realpathSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { validateArtifactDirectory } from "../deploy/no-docker/frontend-artifact.mjs";

const STARTUP_TIMEOUT_MS = 90_000;
const REQUEST_TIMEOUT_MS = 10_000;

function elapsedSeconds(startedAt) {
  return ((performance.now() - startedAt) / 1000).toFixed(2);
}

async function reservePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Unable to reserve a local port");
  return port;
}

async function fetchWithTimeout(url, options = {}) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function absorbResponseCookies(cookieJar, response) {
  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
  for (const setCookie of setCookies) {
    const pair = setCookie.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (!value || /;\s*max-age=0(?:;|$)/i.test(setCookie)) {
      cookieJar.delete(name);
    } else {
      cookieJar.set(name, value);
    }
  }
}

function cookieHeader(cookieJar) {
  return [...cookieJar.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

async function fetchWithCookieJar(cookieJar, url, options = {}) {
  const headers = new Headers(options.headers);
  const cookies = cookieHeader(cookieJar);
  if (cookies) headers.set("cookie", cookies);
  const response = await fetchWithTimeout(url, { ...options, headers });
  absorbResponseCookies(cookieJar, response);
  return response;
}

async function waitForFingerprint(baseUrl, expectedBuildSha, child) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError = "server did not answer";

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Standalone frontend exited with code ${child.exitCode}`);
    }
    try {
      const response = await fetchWithTimeout(`${baseUrl}/api/runtime-fingerprint`);
      const body = await response.json();
      if (response.ok && body.build_sha === expectedBuildSha) {
        return;
      }
      lastError = `status=${response.status} build_sha=${body.build_sha ?? "<missing>"}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Frontend fingerprint was not ready: ${lastError}`);
}

async function assertSuccessfulRoute(baseUrl, route, label, options = {}) {
  const response = await fetchWithTimeout(`${baseUrl}${route}`, {
    redirect: "manual",
    ...options,
  });
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  return response;
}

async function assertProtectedRouteRedirect(baseUrl, route, label) {
  const response = await fetchWithTimeout(`${baseUrl}${route}`, {
    redirect: "manual",
  });
  if (![302, 303, 307, 308].includes(response.status)) {
    throw new Error(
      `${label} did not enforce authentication (HTTP ${response.status})`,
    );
  }
  const location = response.headers.get("location");
  if (!location) {
    throw new Error(`${label} authentication redirect omitted Location`);
  }
  const redirect = new URL(location, baseUrl);
  if (
    redirect.pathname !== "/login" ||
    redirect.searchParams.get("redirectTo") !== route
  ) {
    throw new Error(`${label} redirected to an unexpected location: ${location}`);
  }
}

function extractStaticAssetPaths(html) {
  return [
    ...new Set(
      html.match(
        /\/_next\/static\/[^"'\s>]+\.(?:css|js)(?:\?[^"'\s>]*)?/g,
      ) ?? [],
    ),
  ];
}

async function assertRenderedPage(baseUrl, route, label, options = {}) {
  const response = await assertSuccessfulRoute(baseUrl, route, label, options);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const html = await response.text();
  if (!contentType.startsWith("text/html") || html.length < 1_000) {
    throw new Error(`${label} did not render a complete HTML response`);
  }
  return html;
}

async function assertStaticAssets(baseUrl, assetPaths) {
  if (
    !assetPaths.some((assetPath) => assetPath.includes(".js")) ||
    !assetPaths.some((assetPath) => assetPath.includes(".css"))
  ) {
    throw new Error("Verified pages did not reference both Next.js JS and CSS assets");
  }

  for (const assetPath of assetPaths) {
    const asset = await assertSuccessfulRoute(
      baseUrl,
      assetPath,
      "Next.js static asset",
    );
    const contentType = asset.headers.get("content-type")?.toLowerCase() ?? "";
    const assetBody = await asset.arrayBuffer();
    if (assetBody.byteLength === 0) {
      throw new Error(`Static asset was empty: ${assetPath}`);
    }
    if (assetPath.includes(".css") && !contentType.startsWith("text/css")) {
      throw new Error(`Static CSS asset returned ${contentType || "<no content-type>"}`);
    }
    if (
      assetPath.includes(".js") &&
      !contentType.includes("javascript") &&
      !contentType.includes("ecmascript")
    ) {
      throw new Error(`Static JS asset returned ${contentType || "<no content-type>"}`);
    }
  }
}

async function authenticateRuntime(baseUrl) {
  const cookieJar = new Map();
  const providersResponse = await fetchWithCookieJar(
    cookieJar,
    `${baseUrl}/api/auth/providers`,
    { redirect: "manual" },
  );
  if (!providersResponse.ok) {
    throw new Error(
      `Auth.js providers route returned HTTP ${providersResponse.status}`,
    );
  }
  const providers = await providersResponse.json();
  const credentialsProvider = providers?.credentials;
  const credentialsSignInUrl =
    typeof credentialsProvider?.signinUrl === "string"
      ? new URL(credentialsProvider.signinUrl, baseUrl)
      : null;
  if (
    credentialsProvider?.id !== "credentials" ||
    credentialsSignInUrl?.pathname !== "/api/auth/signin/credentials"
  ) {
    throw new Error(
      "Auth.js providers route did not expose the credentials sign-in provider",
    );
  }

  const csrfResponse = await fetchWithCookieJar(
    cookieJar,
    `${baseUrl}/api/auth/csrf`,
    { redirect: "manual" },
  );
  if (!csrfResponse.ok) {
    throw new Error(`Auth.js CSRF route returned HTTP ${csrfResponse.status}`);
  }
  const csrf = await csrfResponse.json();
  if (typeof csrf?.csrfToken !== "string" || !csrf.csrfToken.trim()) {
    throw new Error("Auth.js CSRF route did not return a non-empty token");
  }

  const callbackResponse = await fetchWithCookieJar(
    cookieJar,
    `${baseUrl}/api/auth/callback/credentials`,
    {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-auth-return-redirect": "1",
      },
      body: new URLSearchParams({
        email: "artifact-verifier@example.com",
        password: "artifact-verifier-password",
        csrfToken: csrf.csrfToken,
        callbackUrl: `${baseUrl}/console/dashboard`,
      }),
    },
  );
  if (!callbackResponse.ok) {
    throw new Error(
      `Auth.js credentials callback returned HTTP ${callbackResponse.status}`,
    );
  }
  const callback = await callbackResponse.json();
  if (
    typeof callback?.url !== "string" ||
    new URL(callback.url, baseUrl).searchParams.has("error")
  ) {
    throw new Error("Auth.js credentials callback did not create a session");
  }
  if (![...cookieJar.keys()].some((name) => name.endsWith("session-token"))) {
    throw new Error("Auth.js credentials callback omitted the session cookie");
  }

  const sessionResponse = await fetchWithCookieJar(
    cookieJar,
    `${baseUrl}/api/auth/session`,
    { redirect: "manual" },
  );
  const session = await sessionResponse.json();
  if (
    !sessionResponse.ok ||
    session?.user?.email !== "artifact-verifier@example.com"
  ) {
    throw new Error("Auth.js session route did not return the verified user");
  }

  return cookieHeader(cookieJar);
}

async function startFrontendRuntime(
  artifactRoot,
  backendPort,
  expectedBuildSha,
) {
  const frontendPort = await reservePort();
  const baseUrl = `http://127.0.0.1:${frontendPort}`;
  const runtimeEnvironment = {
    ...process.env,
    NODE_ENV: "production",
    HOSTNAME: "127.0.0.1",
    PORT: String(frontendPort),
    NEXTAUTH_URL: baseUrl,
    NEXTAUTH_SECRET: "artifact-runtime-verification-secret",
    AUTH_TRUST_HOST: "true",
    BACKEND_API_URL: `http://127.0.0.1:${backendPort}`,
    API_URL: `http://127.0.0.1:${backendPort}`,
    NEXT_PUBLIC_DISABLE_AUTH: "false",
  };
  delete runtimeEnvironment.NEXT_DIST_DIR;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: artifactRoot,
    env: runtimeEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const capture = (chunk) => {
    output = `${output}${chunk}`.slice(-20_000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const runtime = {
    baseUrl,
    child,
    output: () => output,
  };
  try {
    await waitForFingerprint(baseUrl, expectedBuildSha, child);
  } catch (error) {
    await stopFrontendRuntime(runtime);
    if (output) console.error("Standalone frontend output:\n", output);
    throw error;
  }
  return runtime;
}

async function stopFrontendRuntime(runtime) {
  if (!runtime) return;
  runtime.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => runtime.child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (runtime.child.exitCode === null) runtime.child.kill("SIGKILL");
}

async function main() {
  const artifactRoot = path.resolve(process.argv[2] || "");
  const expectedBuildSha = process.argv[3];
  if (!artifactRoot || !expectedBuildSha) {
    throw new Error(
      "Usage: verify-frontend-artifact-runtime.mjs <artifact-root> <expected-build-sha>",
    );
  }

  const totalStartedAt = performance.now();
  const manifest = await validateArtifactDirectory(artifactRoot, {
    expectedBuildSha,
  });
  let sawCredentialLogin = false;
  const backend = createServer((request, response) => {
    if (request.url === "/health/live") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"ok"}');
      return;
    }
    if (request.url === "/auth/login" && request.method === "POST") {
      let requestBody = "";
      request.on("data", (chunk) => {
        requestBody += chunk;
      });
      request.on("end", () => {
        let credentials;
        try {
          credentials = JSON.parse(requestBody);
        } catch {
          response.writeHead(400, { "content-type": "application/json" });
          response.end('{"detail":"invalid JSON"}');
          return;
        }
        if (
          credentials?.email !== "artifact-verifier@example.com" ||
          credentials?.password !== "artifact-verifier-password"
        ) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end('{"detail":"invalid credentials"}');
          return;
        }
        sawCredentialLogin = true;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            access_token: "artifact-access-token",
            refresh_token: "artifact-refresh-token",
            token_type: "bearer",
            expires_in: 3600,
            user: {
              id: 1,
              email: "artifact-verifier@example.com",
              username: "artifact-verifier",
              full_name: "Artifact Verifier",
              role: "admin",
              is_active: true,
              is_verified: true,
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
              last_login: null,
              profile: null,
            },
          }),
        );
      });
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"detail":"not found"}');
  });
  await new Promise((resolve, reject) => {
    backend.once("error", reject);
    backend.listen(0, "127.0.0.1", resolve);
  });
  const backendAddress = backend.address();
  const backendPort =
    typeof backendAddress === "object" && backendAddress
      ? backendAddress.port
      : null;
  if (!backendPort) throw new Error("Unable to start the mock backend");

  let normalRuntime;
  try {
    const startupStartedAt = performance.now();
    normalRuntime = await startFrontendRuntime(
      artifactRoot,
      backendPort,
      expectedBuildSha,
    );
    console.log(`Runtime startup and fingerprint: ${elapsedSeconds(startupStartedAt)}s`);

    const smokeStartedAt = performance.now();
    const login = await assertSuccessfulRoute(
      normalRuntime.baseUrl,
      "/login",
      "Login page",
    );
    const loginHtml = await login.text();
    await assertProtectedRouteRedirect(
      normalRuntime.baseUrl,
      "/console/dashboard",
      "Dashboard route",
    );
    await assertProtectedRouteRedirect(
      normalRuntime.baseUrl,
      "/console/bullpen-ai",
      "Bullpen AI route",
    );
    const authenticatedCookie = await authenticateRuntime(normalRuntime.baseUrl);
    if (!sawCredentialLogin) {
      throw new Error("Auth.js credentials flow did not call the backend login API");
    }
    const proxyHealth = await assertSuccessfulRoute(
      normalRuntime.baseUrl,
      "/backend-api/health/live",
      "Same-origin backend proxy",
    );
    const proxyBody = await proxyHealth.json();
    if (proxyBody.status !== "ok") {
      throw new Error("Same-origin backend proxy returned an unexpected payload");
    }

    const dashboardHtml = await assertRenderedPage(
      normalRuntime.baseUrl,
      "/console/dashboard",
      "Dashboard route runtime",
      { headers: { cookie: authenticatedCookie } },
    );
    const bullpenHtml = await assertRenderedPage(
      normalRuntime.baseUrl,
      "/console/bullpen-ai",
      "Bullpen AI route runtime",
      { headers: { cookie: authenticatedCookie } },
    );
    const protectedAssetPaths = [
      ...new Set([
        ...extractStaticAssetPaths(loginHtml),
        ...extractStaticAssetPaths(dashboardHtml),
        ...extractStaticAssetPaths(bullpenHtml),
      ]),
    ];
    await assertStaticAssets(normalRuntime.baseUrl, protectedAssetPaths);

    console.log(
      `Routes, auth boundary, proxy, and route assets: ${elapsedSeconds(smokeStartedAt)}s`,
    );
    console.log(
      `Verified ${manifest.bundler} standalone artifact in ${elapsedSeconds(totalStartedAt)}s`,
    );
  } catch (error) {
    const outputs = [normalRuntime?.output()]
      .filter(Boolean)
      .join("\n");
    if (outputs) {
      console.error("Standalone frontend output:\n", outputs);
    }
    throw error;
  } finally {
    await stopFrontendRuntime(normalRuntime);
    await new Promise((resolve) => backend.close(resolve));
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(process.argv[1])
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
