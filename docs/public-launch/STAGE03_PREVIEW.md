# Stage03 local review and delivery boundary

Stage03 resumes deployed Stage02 a2e82f0e7f36d4fdafc78f7dbe01553aca49af11. Full stages/03.md remains unchanged. Status records informed progression after the unavailable fresh Stage02 authenticated-browser recheck; it does not substitute owner browser acceptance. Stage04 is not started.

## Runnable application

Real Next.js16.2.5 production build, FastAPI auth/owned job/run handlers and actual WebSocket authorization/relay run locally. Synthetic-only SQLite is a backup in this isolated worktree. Three existing fake accounts, fake Google login, unavailable provider/email/order/AI adapters and in-process fake Redis/pubsub make this a local functional preview, not UAT2 acceptance. Outbound connections remain denied. No real integrations, new credentials, AWS or live databases are used.

Current URL: http://localhost:57764/console/jobs . API: http://127.0.0.1:57765 . Frontend PID87684; API PID87683, with exact start stamps in state.json. Preview state stores PID start stamps and validates them before stopping. Ports are loopback-only. Commands from `/Users/tarunsingh/Documents/Codex/2026-10-19/task-5/stage03-live-boundaries`:

```sh
.runtime/python/bin/python scripts/public_launch/preview.py start
.runtime/python/bin/python scripts/public_launch/preview.py stop
.runtime/python/bin/python scripts/public_launch/preview.py build
```

Build records unused loopback ports; start reuses those compiled URLs and fails if occupied. Stop before rebuilding. A subsequent build may choose new ports; `start` prints exact URLs/PIDs, and `.runtime/stage01-preview/state.json` is current truth. Do not manage other worktrees' previews.

Existing synthetic accounts: `usera@stage01.example.com`, `userb@stage01.example.com`; existing fake password `SyntheticPreview123!`. In Chrome A showed only job2; sign out cleared the private screen; B sign-in then Refresh showed only job3. Direct navigation to known A job2 as B displayed `Job not found`. Refresh B's jobs and inspect Run History; logout and repeat A/B. No old A data should reappear. These read-only completed fixtures do not themselves need continuous UI polling; the protocol check forces real subscribed streams independently.

Visible changes are boundary behavior: logout immediately clears private views and closes sockets; account changes create a fresh document and storage namespace; stale HTTP/socket completions cannot populate the next user's screen. Theme remains a device preference. Existing legacy private caches are purged rather than adopted without an owner marker.

## Revocation semantics

Tickets remain SHA-hashed in Redis with30-second TTL and atomic one-use consume; they carry original authentication time and access expiry, never a reusable raw JWT stream credential. Exact configured Origin and current account/session/resource ownership are checked before accept. Detail producer/consumer channels include owner and resource IDs. Every event is reauthorized and its IDs/linkage checked. Idle reauthorization runs every2seconds with a2-second authorization deadline; failure closes access, and all subscriber/tasks are released. This is bounded polling plus scheduling/transport cleanup, not instantaneous remote revocation.

Logout reuses the existing durable ActivityLog logout record, invalidating **all older sessions for that user**, access/refresh credentials and streams. Fresh high-resolution authentication time permits a subsequent same-second login; refresh preserves the root time so a racing refresh cannot resurrect the session. Legacy credentials fall back conservatively to integer iat. This is deliberately user-wide; no per-device logout store/schema was introduced. Expiry4002 permits a fresh-ticket reconnect; revoked4001 closes all private clients. Client cleanup also occurs on local logout/account switch or observed current-generation auth loss; no claim of offline remote erasure is made. Stage07 module revocation is prepared via authorization hooks, not implemented or certified here.

## Verified evidence

- Expanded backend selection:399 passed before the final shared run-link predicate helper. Final affected ownership/stream selection:54 passed, including26 stream/session cases and28 ownership cases. Real SQL repositories, fake TTL/pubsub and FastAPI TestClient cover expiry, suspended users, logout, reconnect, known/guessed IDs, corrupt cross-owner links, late events, Origin/log redaction and cancellation cleanup. PostgreSQL variant is an isolated CI gate, not a live DB claim. CI exposed a partial recommendation-audit SQLite fixture missing the existing ActivityLog table; the fixture now includes it so real authentication runs without bypass. Local queue fixture checks passed; Redis variants remain exact-head CI evidence.
- Stage01 baseline5 tests, frontend typecheck and actual Webpack build passed. Runtime CI identified a Dashboard byte-budget regression; synchronous socket cleanup was split into a small registry, unused facade enumeration removed, and overlapping private cache prefixes consolidated. Limits were not changed. Final localhost Dashboard measured235494 transferred/760028 decoded bytes, under unchanged235942/760197 growth ceilings; final exact-head Linux runtime verification remains required. Full suite:772 tests,760 passed,12 failed. A full untouched Stage02 source archive reproduced the same12 failures (764 tests,752 passed); no new failure names. See evidence/stage03-frontend-baseline-comparison.json. Closed Bullpen/operator release gates remain closed; this is not a whole-suite green claim. Existing CI selected coverage is preserved and Stage03 regressions added.
- Fresh localhost HTTP/BFF ownership and real WebSocket checks passed on57764/57765: A/B frames isolated, foreign/reused/raw-token/wrong-Origin rejected; logout close4001 observed0.987seconds, no later A frame, old access/refresh denied, ticket query absent from access logs. Sanitized runtime results are in `.runtime/stage01-preview/stage03-live-network.json` and the HTTP/BFF checker output; no tokens/cookies retained.
- Actual Chrome A→logout→B and known foreign detail checks passed on this build. Unit tests cover late HTTP/socket callbacks and physical storage namespaces. This is local evidence, not a fresh UAT2 owner review.

## CI and UAT2 handoff

Before publishing, production deployment push trigger was inspected: main only. The two SSH inspection push workflows match different fixed branch names, not this branch. Stage01 baseline, PR Checks (including native Linux package/offline roundtrip), and disposable-container API migration tests are PR-only; other operational workflows require manual dispatch. Only PR test lists were extended; no production pipeline, migration/model, native nginx/controller, UAT2 access or deployment guard change.

Main freshly read as0c6e61e524c7a87c7b9ea79342f17b14a45e97a1; historical draft1240 remains baseline-only. Publish a separate draft against Stage02, require exact-head CI/artifact verification, then hand off to the parent/existing UAT2 executor. No Stage03 live deployment occurred here. The restricted UAT2 composition continues to deny WebSockets1008 and mutations; do not open them to manufacture deployed multi-user stream acceptance. Parent must report this limitation alongside exact deployed-SHA owner/simulation/read checks and owner review before04.

US$10 and stop21 October2026 21:04:13IST remain unchanged. Current READY/limits require the existing executor's check before any authorized live action. No production merge/deployment, old-UAT recovery, access/credential/key/user changes or external approval is implied.
