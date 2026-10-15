# Public launch status

Stage 00: **BLOCKED — preparation only; isolation NOT verified.** Stage 01 must not start.

## Retention preparation update

- Added [RETENTION.md](RETENTION.md): Critical/High/Medium/Low classification,
  protected unknowns, dependencies, recoverability, holds, proposed TTLs/quotas,
  backpressure, bounded compaction and separate irreversible-action approval.
- Added a synthetic in-memory registry/policy with no production writer hooks,
  filesystem deletion, database, network or scheduling API. Physical purge is
  never authorized by its output. Eleven new synthetic tests plus the existing
  ten preparation tests pass locally (21 total).
- Existing authenticated browser EC2 access now supports read-only host inspection;
  earlier no-access notes below describe the initial preparation environment.
  Deployed checkout and frontend manifest were observed at the preserved main SHA.
  Representative active-worker/market/backup capacity remains unverified.
- Existing immutable captures remain protected; reference census and specific
  archive redundancy decisions are incomplete. No cleanup has occurred. The
  100 GiB cap remains; no paid storage or snapshot change is part of this work.
- UAT remains off. All auth, secret tooling, actual isolation, runtime and
  deployment gates remain open; retention preparation does not satisfy them.

Review date: 2026-10-15. Integration branch: `codex/credx-public-launch-uat`.

## Verified from repository

- Remote main at inspection: `0c6e61e524c7a87c7b9ea79342f17b14a45e97a1` (#1236).
- Prerequisite #1235: `385f61888dfab13ceac1a960f9e508626f407a35` is an ancestor.
- Independent Google account creation, authoritative email verification and existing
  account checks are preserved. This change modifies no application runtime files.
- `deploy.yml` pushes deploy only `main`; manual production dispatch rejects other
  branches. Two diagnostic push workflows target other exact branch names.
  PR checks run on GitHub runners. No existing workflow was changed.
- Production runbook names `/srv/investor`, `investor-*` services, backend 8000,
  frontend 3000. These are documented values, NOT a verified host inventory.

## Prepared and locally checked

- Original stage specification, access/isolation design, release evidence matrix.
- Read-only Linux capacity sampler (no environment or process command dumps).
- Capacity-gated renderer and six non-installed systemd/Redis/network candidates;
  budgets deliberately unset until representative host measurements exist.
- Dark HTTP vhost example, log rotation candidate, shutdown and validation runbook.
- Ten local unit tests pass (including watchdog checks): missing evidence/budgets, invalid resource values,
  template-injection input, memory bounds, candidate rendering, no overwrite.
- Two-sample sampler smoke check passed on the local development environment.
  Those measurements are not production sizing evidence and were not committed.

## Not done / exact blockers

1. No usable SSH/EC2 session or scoped infrastructure connector is available.
   No SSH agent/config, EC2 host configuration, AWS CLI or `gh` CLI was available.
   GitHub source access is not server access. Need verified host access capable of
   read-only inspection followed by narrowly scoped UAT provisioning.
2. Actual deployed frontend/backend SHA, running services, headroom, DB/Redis,
   sockets, schedules, proxy configuration and production health remain unverified.
   Need peak/market/backup/worker observations, not just an idle sample.
3. DNS/certificate management access and an independent UAT Google client are
   unavailable. `https://uat.cred-x.in` is proposed, NOT deployed or verified here.
4. Root AGENTS.md requires the `aws-secrets-manager` skill and `asm-exec` for
   secret work. Neither was available in the inspected environment. Provisioning
   signing/encryption keys, OAuth credentials, Redis ACL or barrier credentials is
   blocked; do not paste those values into chat or bypass the required mechanism.
5. Source finding: `backend/app/core/security.py` uses a hard-coded JWT signing
   placeholder instead of `settings.secret_key`. Separate env files alone do not
   isolate backend tokens. A reviewed UAT-only fix and cross-environment rejection
   tests are required. Do not rotate production keys or change live sessions as
   part of this stage without a separately reviewed production change.
6. UAT runtime auth guards, fake adapters, network policy, actual database,
   authenticated TLS vhost are NOT implemented/deployed by this
   preparation. They require the gates in RELEASE_GATES.md. The backend candidate
   deliberately refers to an absent `app.uat_main` entrypoint and cannot serve the
   unrestricted production app. Do not replace it with `app.main` to get it running.

No production deployment, restart, migration, OAuth/Sheets edit, DNS change,
financial operation or server provisioning was performed. Local checks do not
establish production health or UAT isolation. No capacity numbers were invented.

## Implementation continuation after approval

- Implemented a one-shot resource watchdog for memory, disk, inode and CPU/memory/I/O
  pressure reserves. Dry-run is the default; explicit enforcement can stop only
  five fixed UAT service names. Invalid/missing configuration or metrics triggers
  the stop decision. Failed stop commands are reported as failures.
- Added a dedicated nftables output-policy candidate with distinct numeric UIDs,
  a bounded UAT loopback port list and denial of other IPv4/IPv6 egress. It is not
  installed; host nftables syntax/kernel validation and live denial tests remain
  blocked. No nft executable is available in this development environment.
- The watchdog is not installed/scheduled and does not replace production health
  monitoring. It cannot establish the missing measured thresholds.
- Rechecked both complete available skill catalogs and local skill paths; the
  mandatory aws-secrets-manager skill remains unavailable. Secret/signing-key work
  is still blocked by AGENTS.md. Approval did not supply missing infrastructure
  access. No new authenticated server session is available.
- Remote main remains 0c6e61e524c7a87c7b9ea79342f17b14a45e97a1. No production
  runtime code, Google login code or production workflow was changed.

