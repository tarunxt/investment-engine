# Stage09 session-display repair — local-only successor

Base is exact published `6e56dc99b355f3a1c1ce76ea0433f6865e3750be`, draft PR1251. The containing commit is the new candidate; parent handoff records its full SHA. This phase authorizes local repair/testing/commit only: no push, PR/remote update, deployment, merge, AWS, credentials or Stage10. The original task-5 checkout, uncommitted work and preview51203/51204 remain untouched. Live UAT2 stays accepted Stage08 owner-only simulation.

## Exact change and effect

Only two executable/test source files differ from6e56dc99:

- frontend/components/connections/ConnectionBindings.tsx:10 changed lines. Store the Auth.js session generation alongside owner/data/error in each state update; render that state only while both owner and generation match the current authenticated session. Existing useEffect dependencies, request tickets, AbortController, metadata validation and authority checks are unchanged.
- frontend/tests/stage09-connection-bindings.test.mjs:4 changed lines. Add a harness render without running effects and one regression showing prior metadata disappears on the first render of a same-owner replacement session. Both files were copied byte-for-byte from the already independently reproduced original uncommitted safeguard. No other original edits were integrated; in particular its five extra backend tests, CI-count edit, browser verifier and draft documentation were not copied into tracked source.

User-visible behavior: when the same owner receives a replacement session, the card immediately shows its existing loading state until fresh metadata arrives. Previously it could show the preceding session's masked account/status/readiness for the render before effects cleared state. The same fence covers old error text. This is a stale private-display/session-lifetime fix; the evidence did not establish cross-user API access or credential exposure. Backend ownership, provider approval, encryption, financial/module authority, cookies and API shapes are unchanged.

## Reproduction and local results

First copied only the added regression test onto the6e56dc99 component in this isolated worktree, then ran:

```sh
node --test tests/stage09-connection-bindings.test.mjs
```

Before:7 passed/1 failed/0 skipped. Exact failing identity: `same-owner replacement hides prior binding during the first render before effects`; assertion expected no `PRIOR`, but the prior same-owner binding remained in the returned tree before cleanup effects.

Then copied the verified component safeguard. The following actual-source suites passed:

```sh
# From frontend, using the existing Node dependency runtime
node --test tests/stage09-connection-bindings.test.mjs \
  tests/stage08-module-policy.test.mjs \
  tests/stage08-module-provider-races.test.mjs \
  tests/private-account-boundary.test.mjs
# 33 passed,0 failed,0 skipped;8 connection component checks included

# From repository root; unused synthetic DB/Redis addresses, no live environment
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend ENVIRONMENT=test AUTH_DISABLED=false \
DATABASE_URL=postgresql+psycopg2://unused:unused@127.0.0.1:1/unused_test \
REDIS_URL=redis://127.0.0.1:1/15 \
.runtime/python/bin/python -m pytest -q -p no:cacheprovider --disable-warnings --tb=short \
  backend/tests/test_stage09_connections.py backend/tests/test_zerodha_manual_recovery.py \
  backend/tests/test_stage07_lifecycle.py backend/tests/test_stage06_modules.py
# 89 passed,3090 warnings in13.82s

PYTHONDONTWRITEBYTECODE=1 STAGE01_NODE=/absolute/path/to/node \
.runtime/python/bin/python scripts/public_launch/preview.py build
# Webpack production compilation25.3s; TypeScript14.3s; static generation PASS

.runtime/python/bin/python scripts/public_launch/inventory.py --check
# PASS; unresolved=[]
git diff --check
# PASS
```

Component tests cover initial rendering in both modes, same-owner pre-effect display, session-request cancellation, different-owner late-response denial, logout and malformed/foreign/authority-bearing metadata denial. Module selections, stale PATCH/version floors and private account/session boundaries remain tested. Backend suites exercise the real policy/connection/recovery interfaces with synthetic SQL and fake transports; they do not grant live trading permissions.

The ordinary build initially stopped before compilation because the sandbox denied selecting loopback ports. The normal approved execution then built successfully. No design/guard was changed to bypass that failure.

## Real synthetic application browser checks

A temporary owned-process harness used this worktree's actual Next production build/Auth.js/BFF and existing synthetic FastAPI/SQLite fixture on the build-selected unused loopback ports. It inherited no provider/cloud/SMTP/broker environment. Existing backend socket denial and frontend loopback-only preload stayed enabled; the isolated development Chromium context also denied non-loopback requests. This was not user Chrome, live Google login, UAT2 or provider acceptance.

27 checks passed: real synthetic A/B/admin form logins, correct private account/mode metadata, refresh/reload, logout plus protected-route denial,12 account/mobile-width cases, same-owner reauthentication with a distinct actual Auth.js session generation, a second logout/protected reload denial, and same-browser A-to-B replacement showing B without A metadata. The deterministic component regression establishes the pre-effect render guarantee; browser reauthentication establishes the surrounding actual session/logout/reload behavior without claiming capture of a sub-frame timing window.

Both directly owned Popen child handles were terminated/waited in finally; no shared process discovery/control was used and no original preview was stopped. The fixture/logs remain locally, but no repair preview is left running. The retained harness is task-3/stage09_display_owned_browser.py; browser checks are frontend/.runtime/stage09-display-browser.mjs. These temporary test helpers are outside tracked source. Results, source/log hashes, loopback ports and completed child cleanup are in evidence/stage09-display-repair-local.json and this worktree's .runtime/stage09-display-harness-result.json.

## Preserved evidence and remaining gates

Published6e56dc99, draft PR1251, its15-job CI,34-check no-skip PostgreSQL result, baseline/migration success and independently verified native ZIPs remain unchanged and retained. The new candidate has not been published. Its source/build differs, so the prior native artifact cannot be relabelled or deployed as the repair. See STAGE09_SUCCESSOR_REVIEW.md and the task-3 publication/artifact audit receipts for historical base evidence.

Known14 broad frontend baseline failures remain unresolved and not waived. Their affected files are unchanged; the broad suite was not rerun for this narrow display fix. Four obsolete manual-recovery expectations were reconciled in6e56dc99; the seven resulting recovery contracts still pass. No CI failure was hidden or test replaced with a count-only waiver.

After parent coordinates exact-source publication approval, use the existing unique branch/PR1251 without force-push or merge and recheck remote head/triggers. Publication approval for6e56dc99 does not silently cover this changed SHA. CI plan: run the existing PR Checks/baseline/migration workflows on the new head; require8 connection component checks and34 Stage09/recovery/PostgreSQL contracts with zero skips, plus all existing policy/runtime/build gates. Production workflow remains main-push/manual-only and is unchanged.

Native artifact plan: require `uat2-native-bundle-<newSHA>` and `uat2-native-verification-<newSHA>` from the exact-head native job. Download before one-day expiry; verify GitHub ZIP digests, manifest and frontend build stamps, every application blob and safe extraction mode, controller/proxy integrity,125-wheel completeness and matching Linux offline-install receipt. Do not substitute6e56dc99 bytes. Independent successor review, new CI/artifact verification, any separately authorized UAT2 deployment/verification, owner acceptance and external managed-provider approval remain separate pending gates. Stage10 is not authorized.
