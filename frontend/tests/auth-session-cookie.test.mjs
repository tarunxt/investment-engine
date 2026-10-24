import assert from "node:assert/strict";
import test from "node:test";

import {
  readCookieNames,
  resolveSessionCookieSecurity,
} from "../lib/authSessionCookie.ts";

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

test("cookie headers expose secure and chunked Auth.js cookie names to server routes", () => {
  assert.deepEqual(
    readCookieNames(
      "theme=dark; __Secure-authjs.session-token.0=first; __Secure-authjs.session-token.1=second",
    ),
    [
      "theme",
      "__Secure-authjs.session-token.0",
      "__Secure-authjs.session-token.1",
    ],
  );
});

test("UAT2 uses an independent host-only cookie family and requires runtime signing configuration", async () => {
  const { uat2SessionCookieName, requireUat2AuthSecret } = await import("../lib/authSessionCookie.ts");
  const prior = process.env.CREDX_UAT2;
  try {
    process.env.CREDX_UAT2 = "1";
    assert.equal(uat2SessionCookieName(), "__Host-credx-uat2.session-token");
    assert.throws(() => requireUat2AuthSecret(undefined));
    assert.throws(() => requireUat2AuthSecret("short"));
    assert.equal(requireUat2AuthSecret("unit-test-only-signing-material-never-deployed"), "unit-test-only-signing-material-never-deployed");
    process.env.CREDX_UAT2 = "0";
    assert.equal(uat2SessionCookieName(), undefined);
    assert.equal(requireUat2AuthSecret(undefined), undefined);
  } finally {
    if (prior === undefined) delete process.env.CREDX_UAT2;
    else process.env.CREDX_UAT2 = prior;
  }
});
