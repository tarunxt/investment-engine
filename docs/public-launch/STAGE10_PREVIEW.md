# Stage10 local synthetic preview

Branch: `codex/stage10-connection-authorization-local-20261020`.
Worktree: task-3/stage10-connection-authorization, based on verified Stage09 ccb0b3c4682d6bc65c4b38ccf95e71a446dee117. The containing local commit identifies this candidate; no push/PR/deployment is performed.

Actual local URL: http://localhost:53082/console/profile/connections (API loopback53083). Uses the real Next.js Connections page, authenticated Auth.js BFF and FastAPI handlers, independent synthetic SQLite file and socket-denied fake provider. Local fixtures are not the UAT2 owner or genuine Google/provider login evidence. Existing Stage09 preview/live tabs and services are unchanged.

## Repeatable local operations

Use the repository-constrained Python and frontend dependencies. From this worktree:

```sh
python scripts/public_launch/preview.py build
python scripts/public_launch/preview.py start --foreground
```

Build allocates unused loopback ports and saves them in `.runtime/stage01-preview/build-ports.json`; read the printed URL rather than assuming the ports above remain available. Ctrl-C stops only the directly owned child handles and removes its state. `python scripts/public_launch/preview.py status` displays its saved nonsecret state. Foreground mode does not inspect other process tables. Do not run a second build/start while that preview is running. Stop it first. The original preview's non-foreground behavior remains available but was not used for this Stage10 run.

Synthetic identities: usera/userb/admin@stage01.example.com, existing fixture password `SyntheticPreview123!`. This is a disposable local fixture only, never a deployment credential. Database is `.runtime/stage01-preview/preview.sqlite3`; retain it across restarts to review disabled historical account identities. For an empty reset, stop the owned preview, move only this task's synthetic SQLite file aside, and start again; fixture seeding re-creates it. No live reset command is authorized.

Walkthrough: open Connections; choose either synthetic app mode; simulate callback; review masked broker account and app mode; confirm. Replacing the current account explicitly shows the previous account, invalidates module versions, pauses schedules and cancels stale queued module work. Reconnect/renew starts a fresh attempt. Disconnect disables local token resolution before simulated revocation and reports those outcomes separately. Reload preserves the actual stored state. Historical identities remain available for reconciliation. No module access or execution approval is granted.

## Verified locally

- 89 backend checks pass: 22 Stage10 authorization cases plus23 Stage09 storage/crypto contracts and44 Google/UAT2 boundary regressions. No skips in this selection.
- 13 component regressions pass, including both synthetic setup modes, session-key remount, foreign metadata rejection and existing Stage09 race protections.
- Next.js production Webpack/TypeScript build passes; complete route inventory and workflow syntax checked.
- Real Chrome actual UI: user-owned and managed setup/callback/review/confirm, explicit mode replacement, renewal, disconnect, persistence on reload, corrected metadata refresh.390px CSS viewport has document width390px; mobile disconnect works; temporary viewport restored.
- Offline injected transport verifies official Kite checksum request, revocation request and India06:00 expiry boundary. No live transport was installed or called.

## Explicit pending gates and publication plan

1. No Stage10 CI, PostgreSQL migration or full PostgreSQL callback race has run. New dedicated Docker-only exact-head CI job selects25 mandatory cases (22 shared contracts and3 PostgreSQL cases) and rejects skips. The Stage09 named migration regression now targets its own named revision, preserving its original snapshot assertions rather than mutable head.
2. Existing frozen Stage09 controller/rehearsal provenance checks intentionally reject new runtime files relative to their frozen source. They remain intact. Before proposing publication, prepare a reviewed arrangement that preserves those historical exact-source gates and adds Stage10 schema/controller rollback coverage. Do not expand their allowlist or relabel old receipts as Stage10 evidence.
3. Native UAT2 schema controller currently supports Stage09/Stage08 recovery, not this Stage10 revision. Its code and live state are unchanged. A separately reviewed Stage10 upgrade/rollback plan and fresh backup are required before deployment. This candidate is not deployable merely because its package could build.
4. New routes are mounted only in the private synthetic preview. Production/UAT2 compositions remain closed; real credential-entry, real callback page/transport wiring and provider approval are not activated. Live registered callback/origin verification, actual Google-to-broker session roundtrip, provider revocation and owner acceptance remain pending. No real provider capability is implied by the fake managed approval fixture.
5. Parent coordinates independent source review and any external publication. Intended future PR: a separate draft from this Stage10 branch, based on exact verified Stage09 source/branch after remote state and CI triggers are rechecked. Do not modify PR1251 or push main. Production deploy is push-main/manual only in inspected deploy.yml; no dispatch is performed. No Stage10 publication is authorized yet.

Current statuses: Code LOCAL SYNTHETIC CANDIDATE; CI NOT RUN; UAT2 deployment NOT RUN; UAT2 verification NOT RUN; Owner acceptance PENDING; External approval PENDING. Stage11 excluded. Production/oldUAT/AWS/credentials/access/budget/shutdown/retention unchanged.
