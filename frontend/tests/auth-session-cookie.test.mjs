import assert from "node:assert/strict";
import test from "node:test";

import { resolveSessionCookieSecurity } from "../lib/authSessionCookie.ts";

function resolve(overrides = {}) {
  return resolveSessionCookieSecurity({
    cookieNames: [],
    requestProtocol: "http:",
    ...overrides,
  });
}

test("secure Auth.js cookies stay readable behind an HTTP reverse-proxy hop", () => {
  assert.equal(
    resolve({
      cookieNames: ["__Secure-authjs.session-token"],
      forwardedProtocol: "http",
    }),
    true,
  );
});

test("chunked secure Auth.js cookies select the secure cookie family", () => {
  assert.equal(
    resolve({
      cookieNames: [
        "__Secure-authjs.session-token.0",
        "__Secure-authjs.session-token.1",
      ],
    }),
    true,
  );
});

test("plain local Auth.js cookies remain supported", () => {
  assert.equal(
    resolve({
      cookieNames: ["authjs.session-token"],
      forwardedProtocol: "https",
    }),
    false,
  );
});

test("forwarded and canonical protocols cover requests without a session cookie", () => {
  assert.equal(resolve({ forwardedProtocol: "https, http" }), true);
  assert.equal(
    resolve({ configuredAuthUrl: "https://cred-x.in" }),
    true,
  );
  assert.equal(resolve({ requestProtocol: "https:" }), true);
});
