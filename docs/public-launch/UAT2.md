# CredX UAT2

**UAT2 BLOCKED.** No deployed URL or paid resources. Intended URL:
https://uat2.cred-x.in. This is preparatory work, not a runnable deployment.

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

## Prepared policy and remaining implementation

Default-off `CREDX_UAT2=1` checks exact owner before Google profile lookup/creation,
all token issuance and authenticated-user return. Password registration/login/reset
are blocked; development bypass cannot activate. Dots/plus aliases do not match.
UAT2 startup deliberately refuses until simulation/network integration passes.
Production default behavior remains unchanged. Do not remove lock for a preview.

Still required: independent JWT/Auth.js keys and consistent distinct host-only
secure cookies including BFF decoder; Google certificate-only verification egress;
fake adapters or disabled unsupported modules; email sink/local exports; fixtures;
UI badge/commit; complete deploy/bootstrap/start/stop/status/rollback/reset tooling.
Candidate private network deliberately prevents internet access, so Google verification
cannot currently work. Do not attach application containers to public network to fix it.
Pin reviewed image digests and verify supported tags before any launch. Existing
backend image installs unnecessary broker CLI and reload; frontend uses Node 20.

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

## Deployment/recovery contract to implement

Require immutable images and recorded source commit; validate config without secret
output; start UAT2 DB/Redis; UAT2-only backup; Alembic only inside backend Docker
against verified UAT2 DB; bounded readiness; report commit/result. Start/stop/status
must target dedicated UAT2 only. Application rollback and schema rollback are separate:
restore UAT2 backup or reset approved synthetic fixtures, not merely old image.
No working reset/rollback commands exist yet. Never routine `compose down -v`.

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
