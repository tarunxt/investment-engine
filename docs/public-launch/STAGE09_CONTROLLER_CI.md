# Frozen Stage09 controller integration CI

Runtime/controller/helper/application remain byte-identical to
`1f33c88dac8060abf1487607397def21ee5fe4b9`. Only test harness/fixture, CI and this
record change. Prior receipts remain intact. Exact runtime SHA and verification
SHA are separately recorded; the harness refuses any unlisted changed path.

The dedicated ubuntu24.04 job creates fixed UAT2-named paths and synthetic Unix
users only on its fresh disposable GitHub VM. It refuses existing paths, a
non-runner checkout, a non-systemd Linux environment or missing CI acknowledgement.
It creates a fresh PostgreSQL16 cluster/database, no cloud resources, provider
calls, live credentials, identity marker or IMDS emulation. The VM is discarded
by GitHub after the job. The three-line syntax job dependency correction installs
the repository's exact SQLAlchemy2.0.49 for existing helper tests.

Actual unchanged operations exercised: controller backup and rollback,
configuration/promotion/readiness, pg_dump/pg_restore, schema helper entry point,
Alembic migrations, migration systemd unit, original UID nftables policy and
migration confinement. The previous release comes from the pinned accepted
Stage08 source. Backend/frontend/worker/proxy/Redis/certificate service commands
are explicitly synthetic fixture processes. This is not actual CredX service,
Google-login, HTTPS, UI or live-host acceptance.

Cases include fresh receipt/fingerprint/sequence capture, upgrade and synthetic
binding insertion, preservation/downgrade/transactional restore, late PostgreSQL
DDL error, real disconnect, the controller's actual120s restore timeout, failed
downgrade, controller SIGKILL before and after restore commit, interrupted schema
operation/environment cleanup, unit configuration/promotion/partial-start/readiness
failure and verification-only recovery. Database reset between cases discards only
the disposable fixture and never acts as a recovery shortcut within a case.
Sequence values and is_called are compared/recorded explicitly; transactional
restore is not treated as a guarantee of sequence rollback.

Source/request/action, result/export ownership,0600 modes, cross-user denial,
material checksums and operation-environment cleanup are checked after real unit
execution, including deliberate result-file tampering. Configuration and rename
faults are injected at the controller OS boundary; actual unit operations,
PostgreSQL and migration helpers are not replaced with mocks. Only the AWS host
guard is substituted when testing the pending-marker CLI start gate on a CI VM.
This substitution is never installed in runtime source.

Known local reproduction before CI: a failed promotion rename leaves current.new;
a later promotion raises FileExistsError. The promotion-recovery case requires
success and is intentionally allowed to fail CI on this defect. Do not remove the
pointer, skip the case or publish a runtime fix under test-only authorization.
Any runtime repair is prepared/reviewed separately before publication.

Each case and final receipt are retained even on test failure. Red cases are
reported as failed, never counted as skips, expected passes or live acceptance.
