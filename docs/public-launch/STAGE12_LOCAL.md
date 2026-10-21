# Stage12 local review handoff

Scope: durable server-owned analysis, never unattended financial execution. Candidate SHA is recorded in the external `stage12-local-handoff.json` after commit; this document's containing commit is the source candidate. Stage11 source, acceptance qualification and live environment are preserved.

## Composition and limitations

The standard application returns `enabled:false`; create/control work admission returns503 until a trusted runtime, approved prompt/model plan, entitlement facts and market calendar are supplied by a separately reviewed composition root. No browser flag, request field or environment fallback activates providers. `QueuedAI` reuses persisted existing jobs/outbox and provider-effect policy fences. The fake runtime is imported only by the network-denied localhost harness.

The browser observes persisted records and submits explicit start/pause/cancel/retry/resume controls. Existing manual workflow behavior/calculations remain. Server results are source/plan bound; changed inputs require a new workflow and no approval is carried forward. `sync` validates and freezes the already acquired current portfolio; it does not perform a new broker sync or silently accept an import. Actual new source acquisition retains its existing separately gated workflow.

A schedule is an explicitly submitted one-shot tick; deduplication and missed-run handling are implemented. No recurring scheduler/UI/Beat job is enabled. Calendar facts are server-owned, versioned and immutable for a workflow; production holiday/calendar configuration is pending. Automatic retries are bounded at3 per explicit retry cycle; explicit owner retries preserve total attempt history. Existing job/provider ambiguous-effect limits remain: transactional messaging does not promise exactly-once external billing. Workflows pause/fail rather than falling back to different users, providers or source versions. ORM immutability is application-enforced, not database-administrator-proof.

## Local preview

Use installed Python environment only; no package installation is required in this workspace. From this worktree:

```sh
../stage09-recovery-successor/.runtime/python/bin/python scripts/public_launch/preview.py build
../stage09-recovery-successor/.runtime/python/bin/python scripts/public_launch/preview.py start --foreground
```

Build chooses unused loopback ports; start reuses those compiled ports. Credentials are public fixture `usera@stage01.example.com` / `SyntheticPreview123!`; never use a real account/password. Only this harness enables the trusted synthetic source and deterministic no-network analysis adapter. Select INDmoney US under local Preferences, open `/console/automated-rebalance`, and start **Server analysis**. Leave/close that page; reopen and inspect six persisted stages, attempts/costs/input hashes. Module selection alone does not start a schedule. All outbound socket connections are denied before application imports.

`preview.py status` reads this worktree's recorded state. Stop using Ctrl-C on its owned foreground process. The script's `stop` operation refuses stale/unverified PIDs; never inspect or stop denied/unknown older preview processes. Synthetic state resides only in `.runtime/stage01-preview/preview.sqlite3`; to reset, stop this exact owned preview, archive that disposable fixture database and rebuild/start it. Other worktrees and live UAT2 data are unrelated.

## Verification and next gates

Local commands/results and browser receipts are saved in `evidence/stage12-local-checks.json` and the external handoff. Alembic has not been run locally: AGENTS requires the backend Docker environment. Prepared PG gates use the exact named disposable Docker fixture and reject live URLs. Four PG cases cover duplicate manual/scheduled admission, parallel duplicate consumption and two actual migration roundtrips. The existing twenty-case Linux controller matrix is adapted to Stage12→Stage11 with real PostgreSQL/systemd fixtures; actual application processes remain explicitly simulated.

The accepted Stage11 Linux job is frozen at7c210e7b, with its assertions unchanged, beside new current-source Stage12 gates. Earlier frozen Stage09/10 checks remain. No skip/waiver is permitted; exact head, all case counts, readiness503/actual bounded controller failure, private preservation/hash, restore fingerprint, rollback source, marker clearance and artifacts must pass before any deployment proposal. These jobs are prepared, NOT_EXECUTED. Independent source review, exact CI, package/offline/artifact audits, separately authorized UAT2 backup/migration/deployment, live owner browser acceptance and any external provider/calendar/plan approval remain pending. No Stage13.

## Future schema recovery prerequisites

Migration `durable_analysis_001` follows `indmoney_integrity_001`, adding nullable immutable input metadata and counters/checkpoints to existing workflow tables with a unique owner/request key. A future deployment needs a fresh private Stage11 backup with exact source/manifest/revision/fingerprint and recorded deploy provenance. On rollback, stop app services, preserve new workflow/stage/job/outbox plus previous import/connection material privately, downgrade only the exact successor, transactionally restore the verified backup, verify the complete catalog/data/sequence fingerprint, then restore the pinned application release. Persistent pending markers continue to block startup; interrupted restores require verification-only recovery, not a blind repeat. Local tests do not certify a live restore.
