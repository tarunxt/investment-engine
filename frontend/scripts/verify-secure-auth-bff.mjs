import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { encode } from "@auth/core/jwt";

const frontendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const authSecret = "secure-auth-bff-integration-secret";
const secureCookieName = "__Secure-authjs.session-token";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return address.port;
}

async function waitForFrontend(url, child, output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Frontend exited before it was ready.\n${output.value}`);
    }
    try {
      const response = await fetch(`${url}/api/auth/session`);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Frontend did not start in time.\n${output.value}`);
}

const backendRequests = [];
const backend = createServer((request, response) => {
  backendRequests.push({
    authorization: request.headers.authorization,
    url: request.url,
  });
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ authenticated: true }));
});

const backendPort = await listen(backend);
const frontendPort = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    assert(address && typeof address === "object");
    const port = address.port;
    probe.close((error) => (error ? reject(error) : resolve(port)));
  });
});
const frontendUrl = `http://127.0.0.1:${frontendPort}`;
const output = { value: "" };
const frontend = spawn(
  process.execPath,
  [
    path.join(frontendRoot, "node_modules/next/dist/bin/next"),
    "start",
    "-p",
    String(frontendPort),
  ],
  {
    cwd: frontendRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      NEXTAUTH_SECRET: authSecret,
      AUTH_SECRET: authSecret,
      NEXTAUTH_URL: "https://cred-x.in",
      NEXT_PUBLIC_FRONTEND_URL: "https://cred-x.in",
      BACKEND_API_URL: `http://127.0.0.1:${backendPort}`,
      NEXT_PUBLIC_API_URL: `http://127.0.0.1:${backendPort}`,
      NEXT_PUBLIC_DISABLE_AUTH: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
frontend.stdout.on("data", (chunk) => {
  output.value += chunk;
});
frontend.stderr.on("data", (chunk) => {
  output.value += chunk;
});

try {
  await waitForFrontend(frontendUrl, frontend, output);
  const now = Math.floor(Date.now() / 1_000);
  const session = await encode({
    secret: authSecret,
    salt: secureCookieName,
    token: {
      sub: "1",
      accessToken: "integration-access-token",
      refreshToken: "integration-refresh-token",
      accessTokenExpiresAt: Date.now() + 60_000,
      iat: now,
      exp: now + 60,
    },
  });

  const response = await fetch(`${frontendUrl}/backend-api/auth/me`, {
    headers: {
      cookie: `${secureCookieName}=${session}`,
      "x-forwarded-proto": "https",
    },
  });
  const body = await response.json();

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body, { authenticated: true });
  assert.deepEqual(backendRequests.at(-1), {
    authorization: "Bearer integration-access-token",
    url: "/auth/me",
  });
  console.log("Secure Auth.js session reached the protected backend proxy.");
} finally {
  frontend.kill("SIGTERM");
  backend.close();
  await Promise.allSettled([once(frontend, "exit"), once(backend, "close")]);
}
