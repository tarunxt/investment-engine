# Stage 16 — Order review, safety activity and account support UX

Local implementation started 2026-10-21 13:30:38 UTC from owner-accepted inactive Stage 15 `bb128c1845c53a765083593f476cc3fefbbddb62`. Branch `codex/stage16-order-safety-ux-local-20261021`. Canonical scope: [stages/16.md](stages/16.md). No deployment, activation, external integration or publication is authorized by this work.

## Requirement map before implementation

| Requirement | Reused source / change |
| --- | --- |
| Persisted intent, immutable legs, exact approval, expiry | Stage 14 `order_intents/{models,service,authority,contracts}.py`; no schema or alternate approval system |
| Durable submission, unknown outcomes, reconciliation | Stage 15 `execution.py`, attempts/fences; unchanged and inactive |
| Display owned instructions and outcomes | New bounded `/order-intents/reviews` read projection and actual profile Activity UI; current owner only; masked accounts; no provider call on ordinary reads |
| Current confirmation | Existing authenticated `/approve` with exact digest; only isolated network-denied fake preview installs a runtime; default application dependencies remain absent/503 |
| Recorded holdings/positions | New whitelisted owner-only latest snapshot observations; historical/unverified/missing/truncated labels, no provider contact, no current-account inference or live completeness |
| Disabled-module safety | Existing core Activity route plus independent owned read projection; no optional module admission needed to read owned records |
| Operator history | Existing `modules/safety.py` owner filter and ADMIN restriction retained; frontend lifetime now keyed by owner/session generation |
| No blind timeout retry | UI pending guard; uncertain outcome notice; explicit status refresh; existing backend dedup, expiry and policy checks |
| Cancel / close / disconnect / disable | Explanatory distinction; no financial cancel/close control or automatic liquidation |
| Onboarding / connections / usage / sessions | Existing ModuleRouteGate zero-module onboarding, ConnectionBindings and authorization, account-scoped `/console/apis`; new core AccountSupport links/help; existing Google login preserved |
| Branding / mobile / accessibility | CredX defaults; semantic headings/lists/time, wrapped leg cards, keyboard-focus buttons and status/alert announcements |

## Boundaries and acceptance

Normal analysis and execution runtime remain disabled. A pure read does not authorize current risk, broker status or positions. Up to 50 records prioritize unresolved intents; truncation is explicit and this is not complete positions reconciliation. No new migration or financial integration is required. No real cancel/close support is claimed. Current provider restrictions stay in force.

Local tests, exact-source browser walkthrough, independent review, PostgreSQL/Linux CI, artifact audit, publication and UAT2 deployment/verification/owner acceptance are distinct gates. Only tests with saved results may be marked passed. Existing Stage 15 deployment/evidence is preserved. No Stage 17 work is included. Today's 21:04:13 IST manual stop and US$10 allowance remain unchanged; actual billing is unverified.

## Isolated preview (listener currently blocked)

Use existing installed Python environment and frontend dependencies; no new installs. `scripts/public_launch/preview.py build` then `start --foreground` builds/serves the actual Next.js app and an isolated SQLite backend on unused loopback ports. Only this private harness imports `preview_stage16.py`, installs fake dependencies and seeds synthetic reviewed/unknown/partial history. Outbound networking is denied by the existing harness. Its explicit confirmation uses the real persisted approval handler and fake broker only. Restart retains private synthetic state; use a separately named isolated worktree for a fresh fixture, never reset a deployed database.

Preview credentials are the existing documented public disposable `usera/userb/admin@stage01.example.com` fixture and `SyntheticPreview123!`. User B's module is disabled but its own safety history remains visible. Never reuse these credentials outside this disposable harness. Stop only the owned foreground launcher with Ctrl-C; do not inspect or kill unrelated processes.

## Current verification checkpoint

The first production Next.js compilation passed (13:41:14–13:41:58 UTC), before the recorded-positions addition; final rebuild subsequently passed (13:50:14–13:50:46 UTC), build `sqPafqFLlDMBhXBUBM7O2`, including recorded positions. Safe backend tests and listener-free fake HTTP round trips pass; focused UI tests and TypeScript check pass. Final totals are pinned in the external Stage16 handoff after final checks.

The preview launcher was denied `socket.bind(("127.0.0.1", 0))` with `PermissionError: Operation not permitted` before a server or preview build started. This bind was not retried, no alternate listener was used, and no visual/keyboard/screen-reader pass is claimed. Production compilation is independent of this denied listener operation. PostgreSQL/Linux CI remains unrun locally and must execute with zero skips if publication is separately approved. The existing exact-head Stage15 20-case controller job already covers the unchanged schema/controller; no duplicated recovery runner is introduced. A new Stage16 job prepares four PostgreSQL review/concurrency gates alongside the safe Stage16 suite.

## Review walkthrough when local listener permission is available

1. Build the isolated preview with its supported launcher, then start in foreground. Open its printed localhost URL and sign in as the public disposable `usera` fixture. Open Profile → Activity. Confirm account masking, exact two-leg quantities/limit prices/protection/notional, recorded approval time and unknown/partial warnings.
2. Open two tabs on the same awaiting synthetic intent. Confirm once with the unmistakable exact-basket button; repeated clicks cannot issue another request in flight. The second tab's stale approval is rejected by the existing persisted guard. Refresh/reload to recover authoritative state; fake dispatch yields a filled leg and rejected leg. No real broker is involved.
3. Interrupt a pending request or reload mid-submit. Status remains persisted; no browser continuation is required. A timeout is uncertain, never “safely failed,” and no automatic resubmit/retry/close is offered.
4. Sign out and sign in as disposable `userb`: its optional module is disabled but its own order/snapshot safety history is available; user A records must not appear. Connections, Preferences and personal Usage remain core destinations.
5. Check narrow mobile layout, keyboard focus and button announcement, headings/lists/time/status/alerts with a screen reader. These manual/browser checks are **not yet run** because the local listener bind was denied. Existing component tests cover state transitions but are not a screen-reader pass.

The build produced for compilation-only verification uses inert localhost port 1 endpoints, not a usable preview URL. Do not launch it and claim browser acceptance. A fresh authorized launcher build must select available ports before the browser walkthrough. No alternate listener or denied-bind retry was attempted.

## Local candidate results

- 279 safe backend tests passed, zero skips: Stage16 (25), Stage14/15 regression suites, UAT2 policy/runtime, and module presentation. Saved JUnit/log outside the source worktree in `../stage16-local-evidence/`.
- 63 frontend component/session/module/login-boundary regression tests passed, zero skips, including 13 Stage16 cases.
- TypeScript no-emit check and final production Next.js compilation passed. Build ID `sqPafqFLlDMBhXBUBM7O2`; frontend source/lock hashes saved externally.
- Generated route/source inventory is current with no unresolved registrations. YAML parsing and diff whitespace checks passed.
- Four prepared disposable PostgreSQL Stage16 cases and the existing exact-head 20-case Linux/controller matrix are NOT RUN for this candidate. CI is not triggered, publication is not authorized, and earlier-stage CI is not represented as fresh Stage16 evidence.
- Browser/keyboard/screen-reader/mobile walkthrough is BLOCKED before listener startup by the denied loopback ephemeral-port bind. No alternative listener or denied retry occurred. The final build is compilation-only and points to inert localhost port 1; it is not a running preview.

No schema, migration, recovery controller, real provider, login implementation, production pipeline, credential or live infrastructure changed. Deployment and activation remain separate gates. The exact clean local candidate/source archive is pinned in the external `stage16-local-handoff.json`; no self-referential commit hash is embedded here.
