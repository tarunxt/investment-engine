# Preserved Compose UAT2 package

The owner now selected native systemd preparation. Use native/README.md for the
selected server path. This Compose implementation and its evidence are preserved.

Do not launch until the owner approves the concrete resources/budget and the exact
applicable access/security changes. This package changes no AWS resources itself.

## Build outside production

From a clean committed checkout: `deploy/uat2/build.sh` builds the actual CredX
frontend and restricted CredX backend for Linux amd64. Both images carry the source
revision label. Publish them via the separately verified/approved transfer route;
record immutable registry digests in `.env` using `images.env.example`. The script
does not push images or create a registry. Registry choice/transfer remain pending.

## Prepare the dedicated server after approval

Use the supported stable Docker Engine/Compose distribution for its selected OS.
Do not modify production. Create a dedicated admin identity/access route, encrypted
40-GiB volume, and only approved ingress. Copy this directory and pinned manifest
into a private UAT2 deployment directory. Do not copy production env files.

Provision independent UAT2 secret fields with the mandated aws-secrets-manager
skill and `asm-exec` runtime resolution of the references in the example files.
The required skill and runtime are currently missing: no invocation syntax is
invented here, and unresolved references fail validation. Do not fill examples
from production or substitute manual secret retrieval. Resolved local files must
be mode 0600; the deployment directory must be accessible only to the UAT2 admin.
No secret is created or embedded by this package. The independent Google public
client ID must authorize exactly `https://uat2.cred-x.in` as a GIS JavaScript origin.
No Google redirect callback is needed. Leave Sheets and production client unchanged.

Select supported official Caddy/nginx/PostgreSQL16/Redis7 image digests. All deployed
application and service images are digest-pinned. The initial local validation used
official major-version images; those digests are recorded in UAT2_ACCEPTANCE.md.

## Operations on dedicated UAT2 only

`./uat2ctl validate` checks private configuration, immutable references and Compose.
`./uat2ctl deploy` or `start` pulls pinned images, verifies application revision
labels, starts private dependencies, backs up UAT2 DB, runs Alembic in the backend
container, starts services and performs bounded backend/frontend checks.
`./uat2ctl status` prints service state and UAT2 health.
`./uat2ctl stop` stops application containers, preserving data. **It does not stop
EC2 compute billing**. Stop the approved dedicated EC2 instance through its verified
admin console/API after checking account, instance ID and `credx-uat2` tag.
No code here calls AWS or touches existing stopped instances.

`./uat2ctl backup` creates a private local UAT2-only dump. Copy it only via the
approved artifact route; do not commit it. `./uat2ctl restore backups/uat2-TIMESTAMP.dump`
stops application services and restores schema+data, leaving them stopped on error.
Then select the prior matching digest manifest/source and run `start`. An old image
does not undo migrations. Test backup/restore before relying on rollback.

After the owner has completed verified Google login, `./uat2ctl reset empty` or
`reset populated` resets only UAT2 synthetic US snapshots, retaining identity/profile.
Set `UAT2_FIXTURE_STATE` consistently in backend.env and restart backend to select
matching India and dashboard fixture state. No reset provisions a login or user.
No routine `down -v` or automatic user-data deletion.

## Isolation and limits

Caddy is the only published service. Its independent basic-auth barrier covers all
application pages, login, callbacks, assets, APIs and WebSockets. Caddy's ACME
challenge on port 80 is the minimal public certificate-validation endpoint.
Backend/frontend/worker/Postgres/Redis have only an internal Docker network.
The Google certificate proxy has both networks and only a fixed GET /certs mapping
to Google's signing-certificate endpoint, with upstream TLS verification. It is
not a general proxy. Caddy and that proxy have no Docker socket or cloud identity.
The dedicated fake-AI worker imports only deterministic UAT2 tasks, concurrency 1;
there is no beat/scheduler. Unsupported original modules return UAT2_UNAVAILABLE;
WebSockets close with policy code 1008. Email writes only local UAT2 sink artifacts;
CSV export is a local synthetic response. No live broker credentials are accepted.

Use system disk monitoring (`df -h`, Docker disk usage) and the active time service's
status (`timedatectl timesync-status` or the OS's active chrony diagnostics). Allow
bounded initial synchronization; do not infer a clock fault from one readiness bit.
No custom timer or exact shutdown guarantee is implemented.

Live Google, HTTPS, browser screens, egress and backup/restore acceptance must pass
on the selected approved deployment before reporting UAT2 READY.
