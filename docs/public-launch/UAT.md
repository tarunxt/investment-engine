# Owner-only simulation UAT

Status: preparation only; see [STATUS.md](STATUS.md). Authority and scope:
[stages/00.md](stages/00.md). Every release gate must have actual evidence.

Storage policy and synthetic-only registry preparation: [RETENTION.md](RETENTION.md).
This does not activate production retention, physical deletion or a schedule.

## Access and URL

Proposed URL: `https://uat.cred-x.in`. It is not provisioned by this branch.
User-authorized sole identity: `tarun.singh6893@gmail.com`. Verify this exact email
from authoritative Google claims with `email_verified=true` before activation.
The earlier explicit user choice is authoritative configuration intent, not proof
of a successful Google session. No dots/plus alias ownership normalization.
Distinct supported emails retain independent production accounts.

Two boundaries are required:

1. A separate TLS access barrier before **every** UAT path, including assets,
   Next.js auth routes, backend proxy, errors and WebSockets. It must permit only
   the verified owner; block unknown hosts and alternate public backend ports.
   Choose and implement the barrier after inspecting the existing proxy and
   provisioning its independent credentials through the required secret workflow.
2. Backend UAT policy independently verifies owner eligibility before
   `resolve_google_user`, DB mutation or token issuance. Password/register/reset
   paths must deny in UAT; refresh must recheck active owner identity. Protected
   endpoints must reject non-owner and wrong-token-type requests. No development
   bypass. Check UAT mode/environment consistency and refuse malformed/empty
   allowlists. Production signup behavior must remain unchanged.

Do not mount the complete production router until every reachable integration is
contained. Stage 00 can expose only auth, owner profile, health and synthetic
simulation routes; unavailable modules must fail closed. Synthetic multi-user
fixtures live in isolated tests, not publicly accessible UAT accounts. Disabled
and ambiguous Google account matches still fail closed. No owner data is copied.

Use distinct backend JWT signing material, frontend session secret, encryption
key and OAuth client. Reject the production Google client fallback in UAT. Set
host-only Secure/HttpOnly cookies with suitable SameSite settings and no parent
Domain; test callback, CSRF, expiry and refresh flows. Test production tokens and
cookies against UAT and vice versa. A new hostname alone is insufficient.

## Proposed placement — all values require host verification

| Component | Candidate | Verification needed |
|---|---|---|
| App deployment identity | `credx-uat`, no login/sudo/prod groups | UID, ACLs, capabilities, service-control denial |
| Redis identity | `credx-uat-redis` | separate UID and ACL file |
| PostgreSQL identity | `credx-uat-db` if separate instance fits | available binaries, capacity and socket isolation |
| Release root | `/srv/credx-uat/releases/<sha>`; `current` symlink | root/deployer-owned; runtime read-only |
| Configuration | `/etc/credx-uat` | root-owned, each service reads only necessary files |
| Artifacts | `/var/lib/credx-uat` | synthetic only; quota/retention/monitor |
| Redis data | `/var/lib/credx-uat-redis` | never production data directory |
| Logs | `/var/log/credx-uat`, `/var/log/credx-uat-redis` | rotation and disk stop threshold |
| Frontend/backend | `127.0.0.1:13000` / `127.0.0.1:18000` | no collision, no public binding |
| Redis | `127.0.0.1:16379` | distinct process, bounded memory, ACL, no prod reachability |
| Preferred PostgreSQL | `127.0.0.1:15432`, db/role `credx_uat` | separate cluster in aggregate UAT slice |
| Runtime units | `credx-uat-{frontend,backend,redis}.service` | no production unit dependencies/restarts |
| Aggregate limits | `credx-uat.slice` | all UAT processes, including DB/barrier/monitors |

The preferred separate database instance has no candidate service yet: binary
version, initialization, ownership and capacity must be discovered first. If only
a separate database is supportable, use a non-superuser/non-createdb/non-createrole
role, no role memberships, bounded connections (initial target two per backend,
zero overflow), statement/lock/idle-transaction timeouts. Verify production DB
connection denial, including permissions inherited from PUBLIC and pg_hba rules.
Do not alter or restart production database services to make this fit. If safe
isolation needs such a change, stop and report that option unavailable. Shared
Postgres also means UAT DB work is outside the UAT cgroup; document that risk.

## Inspect before installing anything

Re-fetch current main, verify both baseline commits are ancestors, and compare
the deployed backend and frontend artifacts with their actual runtime manifests.
`git rev-parse` on a server checkout does not prove what is running.
Read proxy configurations and selected non-secret unit properties. Do not print
environment files, credentials, full process arguments, raw SQL/data or secret
manager values. Inspect DB/Redis versions, listeners, namespaces, connection
budgets, cron/Celery schedules and storage without changing them.

The sampler is read-only and uses standard Linux/Python facilities:

```bash
python3 scripts/uat/collect_headroom.py --samples 12 --interval 5 --repo /srv/investor --filesystem /srv > capacity-window.jsonl
```

One minute is a smoke sample, **not representative evidence**. Use existing
monitoring plus repeated market-open/active-worker/backup/quiet windows. Record
CPU busy from deltas of the first eight CPU counters, memory reserve, swapping,
I/O pressure, free space/inodes and production latency/error baseline. Also
measure the actual filesystem for UAT data/logs if different from `/srv`.
Document observation dates, load context, sample gaps and peak production needs.

Set budgets only after review. Leave reserve above measured production peaks and
growth needs; do not shrink production allocations. Copy capacity.example.json
to a non-secret reviewed manifest and fill every field from evidence. Rendering
does not install or authorize starting anything:

```bash
python3 scripts/uat/render_candidates.py reviewed-capacity.json /tmp/credx-uat-candidates
python3 -m unittest discover -s scripts/uat/tests -v
```

The renderer rejects unset/invalid budgets and evidence omissions, but cannot
verify that an operator's evidence is true. `.candidate` files and a root-owned
`ISOLATION_VERIFIED` marker are administrative gates, not security boundaries.
Never create the marker to bypass missing runtime/auth/network implementations.
Validate directives against the actual systemd version and cgroup/controller
support; unsupported limits or BPF filtering must block activation. Confirm
effective `cpu.max`, `memory.high`, `memory.max`, `memory.swap.max`, `pids.max` and
`io.max` values. Do not infer enforcement from configuration text alone.

## Network, simulation and data boundaries

The templates deny non-loopback IP access, but **loopback is not isolation**.
Before starting, implement and test per-UID/per-port firewall rules or an equally
strong namespace boundary. App UID may reach only the approved UAT ports;
explicitly deny production 3000/8000, DB/Redis, Bullpen sockets/runtime, cloud
metadata, arbitrary DNS/IPv6, broker and provider endpoints. No generic proxy,
CONNECT or caller-selected URL relay. Do not flush/replace existing firewall
rules. AF_UNIX access and inherited sockets need independent review.

Google login requires certificate verification: blanket egress denial can break
it. Provide a reviewed fixed-origin certificate relay with bounded timeouts and
TLS validation, or another narrowly scoped verification path. It must not become
a broker/AI egress bypass. Implement/test it before login can be exposed. The
frontend/backend must not silently fall back to production API endpoints.

Fake adapters must be selected at startup and reject real broker configuration.
Use deterministic synthetic holdings, order IDs and fixtures, an email sink and
local test exports. All existing real broker, Bullpen, Sheets, email and AI paths
must be unreachable both in code and at the network boundary. Test all HTTP
verbs, direct adapter calls, websocket messages and task invocation. No broker
credentials are installed. No Celery worker/beat or other scheduler is provided
in these candidates. Future controlled workers require the same slice and gates.

Build immutable artifacts on an isolated runner/local machine, never this live
host. Record SHA, checksum, runtime compatibility and non-secret UAT build env.
Use synthetic seed data only. Resolve the root AGENTS migration guidance with
the actual target: no host-wide Docker/package changes and no production DB use.

## Private validation, exposure, and rollback

1. Check production health immediately before work. Prepare users/directories and
   isolated data services only after capacity/permissions gates pass. Keep the
   external vhost absent or deny-all. Create no public DNS record yet.
2. Implement remaining application/secret/network gates and run private loopback
   tests. Service candidates deliberately require `app.uat_main`, not production
   `app.main`; that entrypoint is not supplied in this preparation.
3. Set measured stop thresholds for MemAvailable, disk bytes, free inodes,
   production latency/error increase, sustained CPU/I/O pressure and swap activity.
   Implement a bounded watchdog; fail safe if metrics cannot be read. Record
   baseline values, evaluation windows and exact stop decisions in evidence.
4. Confirm `credx-uat` cannot read production secrets (`test -r`, without opening
   them), access production sockets/DB/Redis or control production services. Use
   non-mutating permission queries for restart authority; never attempt a live
   production restart as a negative test. Check systemctl/Polkit/sudo permissions.
5. Only then prepare the dedicated authenticated TLS vhost, DNS record and cert.
   Inspect existing proxy rules and inheritance for auth bypasses. Run proxy
   configuration test, review a UAT-only diff, verify graceful reload semantics,
   take before/after production checks and retain the previous proxy config.
   Do not restart the shared proxy or alter production records/vhosts.
6. Run all release tests; record observations, not just commands. Stop/redeploy UAT
   once and show production remained healthy with no restarted production units.

UAT-only stop, once these exact units exist:

```bash
sudo systemctl stop credx-uat-frontend.service credx-uat-backend.service credx-uat-redis.service
```

Add the exact dedicated UAT Postgres/barrier/watchdog units to this command when
created. Never stop a shared production DB. Explicitly stop any future UAT timers
before stopping their services. Candidates have no automatic restart or boot
enablement. Roll back by stopping UAT, selecting the previous UAT artifact and
retesting privately. Do not change production checkout, schemas or service state.
If UAT degrades production, stop UAT immediately and investigate before retrying.

Keep at most two UAT release artifacts initially; clean only the dedicated UAT
release root after verifying the active/rollback paths and ownership. Never apply
retention patterns to shared directories or user data. No repartitioning.

## CI and promotion

Before every push recheck workflow trigger definitions; main may have changed.
This branch must not match production or diagnostic deploy triggers. Use separate
deployment credentials and a future UAT-only environment/job; no prod pipeline
rewrite, disablement or reuse. Current change adds no deployment workflow.
Open a draft PR to main for review only; merging it is outside Stage 00 scope.

Shared host risk remains even with limits: kernel, disk, physical I/O and shared
proxy failure are common; shared PostgreSQL adds engine/connection contention.
Resource caps do not guarantee production availability. If capacity or isolation
cannot be demonstrated, leave UAT stopped and seek a separate host decision.

Primary directive references (verify installed version, not just latest docs):
[systemd resource controls](https://github.com/systemd/systemd/blob/main/man/systemd.resource-control.xml),
[execution sandboxing](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml).

## Implemented watchdog and network candidate

`watchdog.py` runs one check then exits. On threshold breach or unavailable
configuration/metrics, dry-run reports `would_stop`; explicit `--enforce` executes
only the fixed UAT service stop list. A failed stop returns `stop_failed` and exit
status 2, requiring operator intervention. It never starts or restarts services.

```bash
python3 scripts/uat/watchdog.py reviewed-capacity.json --filesystem /srv
```

After private validation, an operator may add `--enforce`. Do not schedule it until
all actual UAT log/data filesystems are accounted for, the fixed unit list matches
the deployment, and measured thresholds are approved. The manifest and scripts
must be root-owned and non-writable by runtime UAT users. An absent optional unit
may cause systemctl to return failure even if other units stopped; verify actual
unit states instead of treating an error as success.

The current watchdog covers host reserve/pressure, not production HTTP latency,
error rates, health or a dead monitor. Add the separately reviewed production
health observer and watchdog scheduling before the gate can pass. Resource
starvation can prevent an on-host monitor from running; external production
monitoring remains necessary. No timer is enabled by this branch.

The renderer now requires distinct, verified `app_uid`, `redis_uid`, `db_uid` and
three pressure thresholds (integer percentages). UIDs must not belong to existing
production processes. It renders `egress.nft.candidate` alongside the five original
candidates. This permits only UAT application loopback destinations 18000, 16379,
15432 and a proposed fixed-origin cert relay at 18802, plus connection replies.
It denies other IP traffic for those UIDs; it does not protect AF_UNIX sockets.
The cert relay remains unimplemented. Do not enable arbitrary external egress
to make Google login work. A shared-database fallback requires a new reviewed
network policy and database denial tests; the dedicated-instance candidate must
not be silently changed to allow production's DB port.

Review and syntax-check with the installed host nftables version before applying
anything; preserve existing tables and never flush the host ruleset. Confirm
coexistence with all current chains. Rule syntax reference:
[Netfilter manual](https://netfilter.org/projects/nftables/manpage.html).
This candidate has not undergone host syntax or live network enforcement tests.


## Component implementation checkpoint

`backend/app/uat/owner_policy.py` and `simulation.py` are independent components
with synthetic tests. Owner admission runs before the injected profile resolver;
its input must already be signature/expiry/nonce-verified Google claims. The
synthetic adapters have no network/file transport and reject real configuration.
Neither component is mounted in a live app or production factory. These do not
replace the missing restricted entrypoint, token/session wiring, Google verifier,
barrier or network isolation tests described above.

The mandatory secret-safety tooling is now available as a pinned local review
copy, from [AWS toolkit commit 9d76dd4](https://github.com/aws/agent-toolkit-for-aws/tree/9d76dd4494b7ff76105f52f5d59ae2180dc91289/plugins/aws-core/skills/aws-secrets-manager).
The skill was loaded, both source Git blob hashes verified, and the wrapper passed
compilation and a no-reference smoke execution with an empty environment. This
does not install the plugin hook or provision runtime credentials. Before secret
operations, verify the approved UAT target secret references, runtime installation
and scoped resolver access. Follow [AWS secret-safety guidance](https://docs.aws.amazon.com/secretsmanager/latest/userguide/retrieving-secrets-ai-agents.html).


## 18 October 2026 audit update

Stage00 remains **BLOCKED**. The historical entries above are not a current deployment inventory. See [requirement-by-requirement audit](STAGE00_AUDIT_20261018.md) for later dedicated-host authorization, completed preparation, partial evidence and missing live gates. Existing-server co-location was not admitted; a dedicated test host does not satisfy that original requirement literally. Current59regression passes do not close private/fault/TLS/realGoogle acceptance. Stage01 remains unauthorized.

Synthetic export follow-up: fixed memory-only destination now wired through the restricted owner HTTP runtime factory;98source tests pass. Disposable engine CI adds export assertions. Retained AWS candidate is unchanged; deployment/live acceptance remains unverified.
