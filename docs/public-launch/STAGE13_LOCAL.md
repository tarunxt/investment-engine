# Stage 13 local handoff and synthetic preview

Branch `codex/stage13-ai-boundaries-local-20261021`, isolated from accepted Stage 12 `367173d5891ad7a8da77c7628f47915248f489c9`. This document's containing commit is the local review candidate; the external handoff records its exact SHA, test logs and source inventory. No publication, CI run, deployment, runtime activation or Stage 14 is authorized here.

Independent review of original candidate `a6a5887e` found that a resolver's hash assertion did not bind its actual holdings to the frozen source. The local successor derives/verifies that projection at generation and consumption; see [correction and regressions](STAGE13_PROJECTION_CORRECTION.md). The original candidate and evidence remain preserved. Fresh independent re-review is pending.

## Runnable backend preview

Use the repository's existing Python environment with backend requirements, SQLAlchemy and the already installed test tooling. No installation is required in this task. From this worktree:

```sh
PYTHONPATH=backend ../stage09-recovery-successor/.runtime/python/bin/python backend/scripts/stage13_synthetic_preview.py
```

The command refuses dotenv files, clears inherited configuration **only inside its own process**, and uses fixed unused import-only DB/Redis endpoints. Its actual data lives in ephemeral in-memory SQLite. It creates two synthetic identities, runs the existing six-stage workflow and five governed fake AI jobs, settles zero-cost receipts, creates/downloads a local JSON artifact, rejects the other owner's download, then rejects download after module disable. Normal runtime stays unregistered. It exits and disposes the database; there is no server, port, stop command, background job, provider SDK invocation, real send or persistent credential. Optional `--output /tmp/new-stage13-receipt.json` writes synthetic evidence with exclusive creation and refuses overwrite.

This is a backend preview, **not browser verification, PostgreSQL migration evidence or live UAT2 acceptance**. Existing Usage & Costs, Preferences and server-analysis screens remain the appropriate UI surfaces. The UAT2 site remains accepted inactive Stage 12; new `/api-usage/limits` and `/api-usage/limits/private-artifacts/{id}` source endpoints are not live. HTTP tests use ASGI in-process and synthetic dependency overrides, with no listening socket or authentication bypass installed in the application.

## Test defaults and limits

`ai_limits/contracts.py` has explicit injectable `Limits`: synthetic tariff/version, US$1 per-owner UTC day, US$5 platform day, US$0.25 operation and US$0.05 reserved upper bound per attempt; three attempts, 4096 conservative input-byte token bound, 1024 output tokens, fanout three; one owner slot and two platform slots; sixteen queued requests per owner and 128 platform-wide. These are **test defaults**, not current prices, customer promises or actual-charge guarantees. Unknown tariff/version/ceilings and invalid finite values are denied. Real models must have reviewed tokenization, transport-side bounds, retry/tool limits and tariffs; none is installed by the fake composition.

Admission shares the existing spend tables. It accounts for existing same-day user balances while serializing governed reservations. Legacy entry points are not silently made compliant or enabled: a cap across uncomposed real-provider paths is not claimed. Normal runtime is `None`, and the only composed provider/storage/mail path is explicit fake/local-sink injection. There is no public method to register or activate it. Real India acquisition still lacks a trusted producer.

Uncertain calls retain reserved funds and a slot, even after cancellation. A known cancelled call can settle cost but cannot publish a result. A tariff breach records actual cost and stops new governed admissions until operator/product review; there is no automatic clearing API. Already-started fenced effects may finish before disable commits; later dispatch/download is denied. This is the existing module fence's linearization behavior, not a promise to undo an external effect.

## Verification and recovery

Run focused local tests with `python -m pytest backend/tests/test_stage13_boundaries.py backend/tests/test_stage13_governed_jobs.py`. Existing Stage 11/12, lifecycle, ownership, provider/output and recovery regressions remain relevant. Native unit tests use `python -m unittest discover -s deploy/uat2/native -p 'test*.py'` with that directory on `PYTHONPATH`. The Stage 13 runner's `GuardTests` and `ReadinessEvidenceTests` do not bind ports. Its two actual HTTP readiness fixtures remain CI-only because the previous local bind operations were denied; no local retry or substitute route is used.

Prepared CI has seven real PostgreSQL concurrency/migration/effect-fence cases in the existing acknowledged disposable Docker fixture and a 20-case PostgreSQL16/systemd Linux matrix based on the accepted Stage 12 recovery point. CI rejects skips and requires the exact collected test count. Historical Stage 12 Linux checks run unchanged at `367173d5`, separately from current Stage 13 checks. No CI job has been triggered by this local task.

`ai_limits_001` extends the two existing spend tables; normal migrations run only in the mandated backend Docker container. None was run locally. Bare downgrade refuses a new Stage 13 operation row. The native controller's existing private preservation/marker/restore process additionally preserves spend and private-outbox evidence before confined cleanup/downgrade to `durable_analysis_001`. Only the exact deployment-linked fresh Stage 12 backup may be restored; application-image reversion alone does not reverse schema. Partial or interrupted recovery keeps applications stopped and marker present. Actual PostgreSQL/Linux execution and artifact provenance remain required before any deployment proposal.

Separate gates remain: independent review; explicit exact-candidate publication/CI approval; fresh exact-head CI/artifact audit; bounded UAT2 deployment with fresh Stage 12 backup and current budget/time authorization; permitted live verification and owner acceptance; real-provider/product/privacy decisions and separate activation/security confirmations. Existing US$10 allowance, 21 October 21:04:13 IST manual stop target and 26 October retention are unchanged. Current billing is not verified, and automatic shutdown is not promised. Production, old UAT/disks, credentials, outbound isolation and all live financial flags remain unchanged.
