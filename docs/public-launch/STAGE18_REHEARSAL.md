# Stage18 local recovery candidate

Base: `3bcd3e4e9022cc04b0319b84963457684d60e1a4`, the independently verified
Stage17 disposable financial-consumer milestone. The separately reviewed
monitoring repair is on PR1259 at `4d913929523cab2adc00f0a842b02ca2ad348f4b`;
its successor CI must be read independently. Neither is UAT2 deployment or
complete public-launch approval. The user's conditional sequencing permits
independent local Stage18 work while minor Stage17 work remains separate.

The first real-service run at `fb28ec83` executed114checks:110passed and4failed.
Three failures were incomplete reflected legacy-profile fixtures: required
timezone/preferences/theme and timestamp values must be supplied explicitly.
The concurrent signup case also failed closed with429. Source inspection and
an exact-function synthetic fence probe reproduce a pre-lock clock-ordering
defect: a request may sample its default time, wait for a concurrent admission,
then mistake that winner's later timestamp for clock rollback. The correction
samples only the default clock after acquiring the durable signup control row;
explicit past times, quotas and invalid ledgers still deny. Dedicated runtime
regressions and the original actual PostgreSQL race are required on the successor;
the isolated function probe is not actual database execution or final diagnosis
of every possible cause of the original429.

A further prepared load sample sends24authenticated/anonymous ASGI requests with
at most3inflight to the real disposable PostgreSQL composition, checking owner,
other-user and administrator identity isolation plus anonymous401. It records
duration/p50/p95/max latency and exact source without provider effects. This is
not browser/proxy/network load or production capacity certification; the wider
capacity target remains unresolved. Its actual execution and retained metric
artifact are required before reporting measured results.

No new product registry, migration, authority, ownership backfill or provider
adapter is introduced here. The rehearsal invokes existing Alembic revisions
inside the existing explicitly acknowledged disposable container, using a
random isolated schema. It starts from `admin_roles_001`, seeds an owner,
two standard Google-style users and a disabled user, then exercises head upgrade,
idempotent replay, downgrade/re-upgrade, preserved opaque legacy credentials,
connection ownership, absent optional opt-ins and no new financial authority.
Google identity acquisition itself is not contacted: concurrent verified-email
account resolution uses the existing server implementation and synthetic input.

The failed-upgrade test raises inside the actual Alembic transaction and compares
rows, table inventory and revision after rollback. A separate pg_dump/pg_restore
test removes and restores only its fixture schema, compares all reflected table
rows and checks the restored user sequence allocates a new ID. This is a
disposable database drill, not UAT2 backup certification or production rollback.
PostgreSQL16 and Redis7 match the retained CI facilities; proxy, persistent
volumes, host services, secret provisioning and real deployment are not rehearsed.
The workflow uses PostgreSQL's official signed PGDG repository for Bookworm and
installs `postgresql-client-16`, not Debian's unversioned client (major15).
Explicit `/usr/lib/postgresql/16/bin/pg_dump` and `pg_restore` are used. Before
dumping, the test compares both reported client majors against the connected
server's actual major16 and rejects mismatches. Client versions are recorded by
CI and must be checked with results. Package-source instructions were verified
against https://www.postgresql.org/download/linux/debian/ on23October2026.

Redis testing publishes only a fake named wakeup to a unique queue/key prefix,
rejects/requeues it and verifies the same task ID and owner/module/version fields.
It does not run a provider or infer authorization from a message. Retained Stage17
authenticated composition and actual child-worker tests are selected separately
to validate admission, crash/replacement and duplicate-effect prevention. Keys
removed during fixture teardown belong only to its unpredictable private prefix.

The snapshot checker is a closed, bounded projection consistency checker: it
requires unchanged identities/roles/private ownership, preserves module and
connection state, rejects unknown modes/roles and requires explicit disposition
of incompatible queued work and unresolved ownership. It neither migrates records
nor makes an untrusted snapshot authoritative. The JUnit gate rejects missing,
duplicate, skipped/xfail, failed and errored cases; it binds an exact SHA and
the supplied XML digest. A generated receipt is consistency evidence, not proof
that a claimed database, browser or load environment actually ran.

## Executed and pending evidence

Local stdlib tests cover the projection and JUnit gate. Syntax/whitespace checks
are safe without installed package metadata. Real PostgreSQL/Redis and the normal
pytest suite have NOT executed on this Mac: service binaries/container runtime
are unavailable and existing pytest entry-point discovery timed out before tests.
No plugins were disabled, dependencies installed, listeners started or tests
counted as passed after that timeout. The candidate workflow is prepared but
unpublished; publishing Stage18 requires its own applicable authorization.

## Finite acceptance checklist

1. Independent exact-diff review and actual disposable PostgreSQL/Redis execution
   of every new service case with zero skips; retain XML and exact-head receipt.
2. Full release matrix evidence: owner/other/admin, each module/none/combinations,
   both Kite modes/switch, HTTP/BFF/WS/tasks/exports, account switch, disable races,
   budgets, imports, durable workflows, forged approvals and broker uncertainty.
   Existing test evidence may be reused only with exact source/diff applicability;
   the prepared workflow is a subset, not a claim that this full matrix passed.
3. Retain actual restore/rollback results, every owner's counts/orphan checks,
   concurrent signup and Google-login regression results. Snapshot equality alone
   does not satisfy the real-database prerequisite.
4. Supported isolated browser/layout/error-state acceptance and bounded disposable
   load execution with measured concurrency, duration, latency/error thresholds
   and unresolved target. No prior denied listener is retried by this candidate.
5. Exact-head artifact/offline audit and an honest Code/CI/UAT2/owner/external
   ledger. UAT2 remains stopped; no renewed runtime/spend/deployment authority
   or public/provider/legal approval is inferred from local tests.

Complete account export/erasure, retained/shared raw content, identity/backups and
real evidence/perimeter/consumer/monitor bindings remain explicitly restricted.
The nine real release gates are neither manufactured nor waived by this rehearsal.
