# CredX UAT2

**UAT2 BLOCKED.** No deployed URL or paid resources. Intended URL:
https://uat2.cred-x.in. The owner selected native systemd preparation; live deployment acceptance remains pending.
See deploy/uat2/native/README.md for the selected package. Compose remains preserved history.

## Source

Branch `codex/uat2-owner-only-20261019`, isolated checkout at
`/Users/tarunsingh/Documents/Codex/2026-10-19/task-3/investment-engine`.
Fetched current main `0c6e61e524c7a87c7b9ea79342f17b14a45e97a1` (#1236);
`385f618` is an ancestor. Newer Google-login behavior preserved.
Stage01 task `01a15432-5d0b-7574-a54f-fc7fae65a01a` owns
`codex/stage01-scope-recovery-20261019`, observed at `f25811dd` after `940994b2`.
Its checkout was read only, no commits integrated or module controls claimed.
Parent coordination message to `01a14a6b-8cc5-75a6-ba97-9acc2cb8f019` failed:
`thread not found`. Coordinate source commits through parent before integration.

## Short preflight

- Actual stack: Next.js/Auth.js, FastAPI, PostgreSQL, Redis, Celery. Initial preview
  needs no scheduler/live-trading workers. Existing Compose publishes database,
  Redis and adminer; unsuitable as-is. Candidate `deploy/uat2/compose.yaml` uses
  one Caddy/frontend/backend/Postgres/Redis host, internal network, separate
  volumes, memory bounds and log rotation, no schedulers. It is incomplete.
- Docker CLI available; daemon `/var/run/docker.sock` absent. Container tests blocked.
- AWS CLI read-only STS returned `Your session has expired. Please reauthenticate
  using 'aws login'.` Account 457945009677/Mumbai is owner-supplied, not independently
  verified. DNS control, subnet, SSM/admin and package-transfer routes unverified.
- AGENTS mandates `aws-secrets-manager` skill plus `asm-exec`. Neither found in
  available catalogs/PATH. No secret access attempted. AWS compute skill read at
  `~/.agents/skills/aws-compute/SKILL.md` for planning.
- GIS flow sends ID token through Auth.js credentials provider to backend signature,
  issuer, audience, expiry, verified-email checks. Independent UAT2 public client
  and exact JS origin `https://uat2.cred-x.in` required; no redirect callback for
  this flow. Production Google client and Sheets configuration untouched.
- Baseline `core/security.py` hardcodes JWT signing key. UAT2 key isolation must
  be fixed before launch. Secret-tool requirement remains in force.

## Implemented preparation

Selected runtime: native systemd. Compose descriptions below record the preserved
alternative; they are not the current deployment instruction.

Default-off CREDX_UAT2=1 enforces exact owner before Google provisioning and token
issuance, rejects alternate password paths and refresh-token-as-access requests.
UAT2 JWT uses an independent required key plus UAT2 issuer/audience. Auth.js uses
required independent signing configuration and distinct __Host-credx-uat2 cookies;
proxy and BFF decoders select that same family. Production defaults are preserved.
No deployed keys were generated, read or copied. Runtime configuration remains
blocked by missing mandated secret tooling.

Restricted app.uat2.main reuses actual CredX auth and US portfolio routes, with
synthetic fixtures created only after verified owner login. Existing India/dashboard
schema contracts use deterministic test adapters. Unsupported modules return
UAT2_UNAVAILABLE, WebSockets close with 1008, live broker callbacks are unavailable.
Fake AI runs in a dedicated bounded Celery queue; email sink and synthetic CSV are
local only. Actual frontend has UAT2/build banner and /console/uat2 walkthrough.
Stage01 controls remain pending, not imitated.

Selected native lifecycle/offline package/configuration/rollback instructions are in
deploy/uat2/native/README.md. Preserved Compose instructions remain in deploy/uat2/README.md. Native bundles carry exact source/platform/checksum manifests; preserved images carry source labels. Startup rejects missing/real adapters, production DB/Redis, missing keys,
production Google client, missing source SHA or auth bypass. Original app.main
cannot be used in UAT2. The restricted entrypoint cannot start outside UAT2 mode.

Network design places app/data/worker on internal network only. A fixed-purpose
nginx proxy fetches only Google's signing certificates and verifies upstream TLS.
Caddy barrier covers every app route/asset/API/WebSocket; only ACME validation is
public. Container/runtime and live acceptance results are recorded separately.

## CLI versus browser account inspection

AWS CLI authentication remains expired; no aws login attempted. Existing authenticated
Chrome console independently verified account 457945009677 and Mumbai selection.
Route53 showed zero hosted zones. Public NS lookup returned ns63.domaincontrol.com
and ns64.domaincontrol.com, so exact external DNS account access is still unverified.
Systems Manager Mumbai showed zero managed nodes; no setup/grants enabled. SSM and
transfer route are not established merely by the console being accessible.

Docker Desktop was present. Initial user socket was absent; opening its existing
app timed out, then the daemon socket appeared. Sandboxed CLI access was denied by
filesystem permissions; authorized read-only check outside sandbox succeeded:
Engine 29.8.2, Compose v5.6.0. No software installed or unexpected permissions granted.
Docker is an optional design choice, not an application prerequisite; native assets
exist under deploy/no-docker. Their production backend unit includes credential-sync
and must not be reused unchanged. Artifact packager/runtime logic could be adapted,
but separate UAT2 units/users/paths/network rules would still be needed.

## Resource and cost proposal draft — no launch approval requested yet

Intended account/region 457945009677/ap-south-1; names `credx-uat2`, `credx-uat2-sg`,
`credx-uat2-admin`, `credx-uat2-root`. Candidate one x86 Linux t3a.large (2 CPU/8 GiB),
standard credits, 40 GiB encrypted gp3, one public IPv4; external image build.
No ALB/NAT/helper. SSM preferred if available; otherwise exact admin /32 and separate
key need approval. No production role. Inbound 443; 80 only for ACME/redirect.
No DB/Redis/API public ports. Proposed Caddy independent basic-auth barrier covers
pages/assets/API/WebSockets including login. Only certificate validation is public.
Access arrangement itself still requires approval, and Google acceptance stays pending.

Unverified planning assumptions: compute $0.10/hour, gp3 $0.10/GiB-month, IPv4
$0.005/hour, 730 hours/month. Running ~$0.1105/hour or $80.65/month; stopped retaining
disk+IPv4 ~$7.65/month. Compute/storage need current regional quote. Public IPv4
reference: https://aws.amazon.com/vpc/pricing/. Transfers, secrets, snapshots,
DNS queries and applicable tax extra. Illustrative 18% tax is not a verified account
rate. Proposed 48-hour test plus 7-day stopped retention approximately $7.1 pre-tax,
plus variable services; tentative $15 allowance is monitoring, not a guaranteed cap.
No automatic-stop mechanism proposed until verified. Manual/API stop has latency
and failure limits; retained disk/IPv4 continue charging while stopped.

Before a concrete paid approval request: restore account access, verify DNS/admin/
transfer route and exact resources/current rates; finish code and local container
checks. IAM/access/firewall/secret/Google changes require applicable exact action-time
security confirmation. This draft is not approval and no new charges were incurred.

## Native deployment/recovery contract

The owner explicitly selected native systemd preparation on a separate server.
The restricted application code is reused. New code is packaged offline in Linux CI.
Native UAT2 units/users/paths/PG16/Redis and scoped process firewall templates are
prepared without executing host setup. Runtime migrations use the dedicated native
venv in a confined oneshot UAT2 unit; the owner-selected native path supersedes
Docker-only migration tooling for this new UAT2 path, without changing other workflows.


Require immutable images and recorded source commit; validate config without secret
output; start UAT2 DB/Redis; UAT2-only backup; Alembic only inside backend Docker
against verified UAT2 DB; bounded readiness; report commit/result. Start/stop/status
must target dedicated UAT2 only. Application rollback and schema rollback are separate:
restore UAT2 backup or reset approved synthetic fixtures, not merely old image.
Commands are prepared; runtime backup/restore acceptance remains pending. Never routine `compose down -v`.

## CI safety

All workflow triggers inspected. deploy.yml pushes only main; manual rejects non-main.
Other push inspection branches `codex/fix-ranking-errors` and
`fix/sports-ranking-live-validation` do not match UAT2. Production disk recovery is
manual-only/guarded. PR jobs are checks/disposable DB tests. No workflow modified.
Dedicated push/draft PR do not trigger production deployment. No merge/dispatch.

## Existing Stage00 attention

Original root `vol-0820f7e4073a37848` retention only until 20 October 2026 15:00 IST
(09:30 UTC), owner-supplied. No extension. Helper root `vol-07d700a05ead8ed67` must
not be deleted; may contain unique logs. Instances `i-0dea5617814f8b351` and
`i-0cb5d69e6b140b2da` remain untouched. Production `i-0b8ad0aebce8510cb` excluded.
Old policies/transfer permission not reused; Stage00 remains separately BLOCKED.
