# Bullpen Run Audit Error Troubleshooting

Use this runbook when **Bullpen AI Review → Runs Audit → run detail** fails to open or shows a server/API error.

## What the page calls

The run-detail page loads the selected run through the Bullpen run-audit detail API. The run ID in the browser URL is the primary investigation key.

Example console route:

```text
/console/bullpen-ai/analyse-runs/<run-id>
```

Backend route:

```text
GET /bullpen-ai/run-audits/<run-id>
```

The detail read may materialize/reconstruct the audit snapshot before returning it, so failures can come from snapshot reconstruction, persisted run/stage data, order summarization, finding generation, database access, or response validation/serialization.

## What the generic message means

`An unexpected error occurred` is the production-safe message returned by the global FastAPI exception handler for an **unhandled backend exception (HTTP 500)**. It is not the root-cause exception itself. The real exception and stack trace remain in backend logs.

After the diagnostics hardening change, the response also carries a safe **Reference ID / correlation ID**, and the backend exception log records the request method, path, and the same ID. This lets an operator find the exact stack trace without exposing it in the browser.

## Triage procedure

1. Record the **run ID** from the URL and the **Reference ID** shown in the error message.
2. Open browser DevTools → **Network** and reload the page. Select the failed run-audit request and record:
   - HTTP status
   - response JSON (`error`, `message`, `details.correlation_id`)
   - `X-Correlation-ID` response header
   - request path
3. Interpret the status:
   - `401`: session expired/revoked; sign in again.
   - `403`: authenticated user lacks access.
   - `404`: the run/snapshot cannot be found for that user.
   - `429`: throttled; retry after the service recovers.
   - `5xx`: backend failure; continue with the Reference ID and logs.
   - network/timeout/invalid JSON: inspect proxy/backend health before changing run data.
4. Search backend logs for the **correlation ID** first. If necessary, also search the request path containing the run ID. The unhandled-exception log should include the full stack trace.
5. Classify the failing layer from the first application frame in the traceback. For run-detail 500s, inspect in this order:
   - `bullpen_run_audit.service.materialize_run_audit_snapshot_sync`
   - persisted run record conversion (`record_to_run`)
   - decision/order summarization
   - `_build_bundle` / snapshot completeness
   - stage/event/formula serialization
   - deterministic finding generation and evidence sanitization
   - snapshot/blob persistence
   - schema construction/response serialization
6. Reproduce with the same run ID in a non-production environment or with a sanitized copy of the failing persisted shape. Do **not** mutate production evidence merely to make the page open.
7. Fix the failing parser/materializer so legacy, partial, null, or malformed-but-recoverable data is handled explicitly. Add a regression test containing the minimum failing shape.
8. Deploy and verify:
   - the original run detail opens;
   - list/history pages still load;
   - detail sections open;
   - no new 5xx appears for the same Reference ID/run ID pattern;
   - the regression test passes.

## Rules for future errors

- Never replace a server exception with only a generic UI string; always preserve a safe error code and correlation/reference ID.
- Never expose stack traces, secrets, tokens, raw provider payloads, or database credentials in the browser response.
- Log unhandled exceptions with `method`, `path`, and `correlation_id`, plus `exc_info`/stack trace server-side.
- Keep the same correlation ID from browser → API → response → logs.
- For a run-specific failure, include the run ID in the URL/path or structured server log context.
- Treat historical/frozen audit snapshots as evidence. Fix parsing/reconstruction logic rather than destructively editing source records.
- Every fixed production 500 should gain a regression test for the exact failure class.

## Minimum information for a future bug report

```text
Page: Bullpen AI Review → Runs Audit → Detail
Run ID: <uuid>
Timestamp/time zone: <time>
HTTP status: <status>
Error code: <code>
Reference/Correlation ID: <id>
Failed request path: <path>
First relevant backend stack frame: <file:function:line>
Expected result: Run audit detail opens
Actual result: <brief symptom>
```

This information is sufficient to move from the browser symptom to the exact server exception while keeping production internals private.
