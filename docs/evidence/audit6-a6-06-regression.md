# A6-06 regression verification

Status: verified already resolved. No runtime change or redeployment required.
Current main and production baseline verified on 2026-11-01:
`968ac9c16ca0f88df4c68732c13792787cc66e60`.

The accepted corrections in PRs 1381/1382/1383 remain intact. Missing source
evidence leaves Stage 1 not evaluated, event/export counts unknown, Stage 2/3
unknown, and nested diagnostics completion/runtime/positions unknown. Sports
Breakup independently renders no completed snapshot rather than an empty count.

The existing actual-component browser regression now accepts either workspace
profile, seeds its own namespaced saved snapshot, clears both fixture databases,
and checks unknown accessible event/export labels and backward keyboard trapping.
Account defaults are replaced with synthetic identifiers only in the isolated
bundle; assertions prevent account addresses leaking into fixture evidence.
Production code, calculations, stored history, permissions and actions are unchanged.

Reproduce from `frontend` (esbuild must be installed separately):

```sh
STATE_BOTS_ESBUILD_PATH=/tmp/a6-06-build/node_modules/esbuild STATE_BOTS_WORKSPACE_PROFILE=bullpen007 STATE_BOTS_EVIDENCE_DIR=/tmp/a6-06-evidence/007 node tests/state-bots-source-correction.browser.mjs
STATE_BOTS_ESBUILD_PATH=/tmp/a6-06-build/node_modules/esbuild STATE_BOTS_WORKSPACE_PROFILE=bullpen-sports STATE_BOTS_EVIDENCE_DIR=/tmp/a6-06-evidence/sports node tests/state-bots-source-correction.browser.mjs
STATE_BOTS_ESBUILD_PATH=/tmp/a6-06-build/node_modules/esbuild node tests/state-bots-count-labels.browser.mjs
STATE_BOTS_ESBUILD_PATH=/tmp/a6-06-build/node_modules/esbuild node tests/state-bots-status.browser.mjs
node --test tests/bullpen-sports-workspace.test.mjs tests/bullpen-sports-breakup.test.mjs tests/bullpen-auto-run-stage-status.test.mjs tests/trading-bots-passive-summary.test.mjs
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js tests/state-bots-source-correction.browser.mjs tests/fixtures/state-bots/correction.jsx
```

Validation: both profile browser runs pass failed initial load, rejected source
reads with retained saved 0/12 counts, cached zero diagnostics, desktop 1180x757,
narrow 390x844, Tab/Shift+Tab containment, Escape and return focus, accessible
unknown control names, and no horizontal overflow. All reads use mocks; outgoing
requests are blocked. No operational API calls or browser errors occurred.
Existing count-label regression passes five states and 25 export names.
Existing status regression passes eight loading/empty/populated/failed/partial/
stale/queued/running fixtures. Its live schedule reads remain synthetically
unavailable; it is not successful full-workspace backend acceptance.
Focused Node suite: 23/23 pass. TypeScript and changed-test ESLint pass.

Broader baseline suite: 49/51 pass. The two unchanged failures in
`bullpen-auto-run-progress.test.mjs` are "exposes Stage 1 output candidates" and
"exposes Stage 1 active Bullpen positions". Actual objects include additional
nullable fields absent from expected objects. They failed before these test-only
edits; production behavior and those tests were not altered.

Synthetic screenshots and result JSON remain local outside this source commit.
Original audit PDF could not be downloaded through the supported Library helper
after the bounded retry. Its resolved current version was 3 (the assignment cites
version 2). No original screenshot visual review is claimed. Synthetic Sports
main-state and both profiles' narrow diagnostics pixels were inspected.

No live browser/runtime, service recovery, configuration, jobs, push, PR, merge or
deployment was performed. Fresh authenticated release read-back remains with the
integration owner after Audit7 handoff. Source recovery is a separate objective.
