import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

async function loadApiErrorsModule() {
  const source = readFileSync(
    new URL("../lib/apiErrors.ts", import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: "apiErrors.ts",
  });

  return import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
  );
}

test("deriveApiErrorMessage handles nested and string payloads", async () => {
  const {
    deriveApiErrorMessage,
    formatApiErrorSummary,
    splitApiErrorSummary,
    stringifyErrorDetail,
  } = await loadApiErrorsModule();

  assert.equal(
    deriveApiErrorMessage({ detail: { error: "Bullpen claim rejected" } }),
    "Bullpen claim rejected",
  );
  assert.equal(
    deriveApiErrorMessage("Bullpen claim rejected"),
    "Bullpen claim rejected",
  );
  assert.equal(
    deriveApiErrorMessage(undefined, "Fallback message"),
    "Fallback message",
  );
  assert.equal(
    stringifyErrorDetail([
      { detail: "first" },
      { message: "second" },
    ]),
    "first; second",
  );
  assert.equal(
    formatApiErrorSummary({
      status: 400,
      message: "API request failed",
      details: { detail: "RuntimeError: Bullpen claim rejected" },
    }),
    "HTTP 400: API request failed. Details: RuntimeError: Bullpen claim rejected",
  );
  assert.deepEqual(
    splitApiErrorSummary({
      status: 500,
      message: "An unexpected error occurred",
      details: {
        error: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred",
      },
    }),
    {
      statusText: "HTTP 500",
      message: "An unexpected error occurred",
      details: "Code: INTERNAL_SERVER_ERROR",
    },
  );
});

test("deriveApiErrorMessage preserves actionable server diagnostics", async () => {
  const { deriveApiErrorMessage } = await loadApiErrorsModule();

  const message = deriveApiErrorMessage({
    error: "INTERNAL_SERVER_ERROR",
    message: "Bullpen run audit could not be generated",
    details: {
      error_type: "IntegrityError",
      correlation_id: "corr-123",
      request_path: "/bullpen-ai/run-audits/run-123",
      resolution: "Inspect backend logs using the correlation ID.",
    },
  });

  assert.match(message, /Bullpen run audit could not be generated/);
  assert.match(message, /Code: INTERNAL_SERVER_ERROR/);
  assert.match(message, /IntegrityError/);
  assert.match(message, /corr-123/);
  assert.match(message, /\/bullpen-ai\/run-audits\/run-123/);
  assert.match(message, /Inspect backend logs using the correlation ID\./);
});
