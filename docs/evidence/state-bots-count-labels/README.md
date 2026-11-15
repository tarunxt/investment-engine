# Event-action count availability

Original finding: Bot unknown-versus-zero source-state acceptance. Failed or
loading Stage 1 sources must not announce zero events in an action name while
the associated metrics remain unknown. Verified zero and cached known counts
retain their real values.

Base: f7e76768baa94345c7a2585d58d2a4ab3956f54d. Worker provenance:
8b32117a51ba2383301d0e5ceafa83279166ef96. The private Git bundle could not be
materialized, so the original commit was not imported. A forwarded source/tests
patch was decoded, checked at exactly 14,282 bytes and SHA-256
99e2f5d1ed0ec2a8daee9c48fe3b40b9892ed8de20e721cc7fe85e72ff7262d2,
then applied cleanly. All three resulting file blobs match the patch indices.
Original worker screenshots, JSON and logs were not imported; evidence was
regenerated locally against the exact source/tests patch.

The runtime diff only moves the existing not-evaluated display guard before the
included-active label and makes event/export labels and the scanned-export
tooltip respect that guard. An AST comparison with the base confirms all 155
onClick and disabled JSX attributes are identical. Action-handler definitions,
source reads, calculations, stored data, audit capture and execution are unchanged.

Local validation: 525 required frontend regressions; 28 focused overview,
Copy/Direct passive-page and stage-status tests; TypeScript; and five actual
StageOneRunStats browser fixtures passed. The fixtures check 25 export labels
across loading, failed, failed-independent, verified-zero and cached-known states,
at 1180px/default zoom and 390px narrow width. They retain verified 0/12 values,
check existing disabled predicates, keyboard Enter/focus and no overflow, and
report zero API calls/browser errors. Existing schedule lint remains two errors
and five warnings, identical to base. No assertion or budget was weakened.

Reproduce from frontend:

```sh
STATE_BOTS_ESBUILD_PATH=/tmp/credx-build/node_modules/esbuild node tests/state-bots-count-labels.browser.mjs
node --test tests/trading-bots-passive-summary.test.mjs tests/polymarket-bot-passive-read.test.mjs tests/bullpen-auto-run-stage-status.test.mjs
npx tsc --noEmit
```

Synthetic screenshots/result JSON were inspected and retained locally outside
this source release. These are isolated actual-component fixtures, not live
authenticated UI acceptance. Final commit, CI and deployment evidence belongs
to the sole integration release; the parent owns fresh live acceptance.
