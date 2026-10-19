# Native CredX UAT2

The owner selected native systemd preparation on a separate server. Compose history
and its logs are preserved. This package is not authorization to launch a server,
change security access, provision secrets, alter DNS/Google configuration or deploy
production. No native host setup/deployment has been executed.

## Selected stack and prerequisites

Fresh dedicated Ubuntu24.04 Linux x86_64 host; Python3.12 + venv, Node22,
PostgreSQL16, Redis7, Caddy2, nginx, nftables and systemd (IPAddressDeny cgroup-BPF adds defense in depth),
systemd-timesyncd, and standard PostgreSQL client tools. Verify supported package
sources and installed binaries before the concrete launch proposal; do not install
anything on production. Builds occur on isolated Linux CI/local builder, not server.
No Kubernetes, helper disks, broker CLI, live adapters, Beat or scheduled jobs.

Dedicated identities: credx-uat2-app, -web, -db, -redis, -certs, -proxy.
Code: /opt/credx-uat2/releases/<full-commit>, atomic current symlink.
Config: /etc/credx-uat2; resolved environment/identity files root-owned0600.
Data: /var/lib/credx-uat2 with separate per-service directories. Internal bindings:
backend127.0.0.1:8002, frontend127.0.0.1:3002, PostgreSQL127.0.0.1:5542,
Redis127.0.0.1:6479, fixed certificate proxy127.0.0.1:18082.
Only the dedicated Caddy exposes HTTPS; port80 serves ACME/redirect as approved.
Its admin API is disabled. Independent barrier covers login, assets, APIs and sockets.

A required nftables unit denies non-loopback traffic for only the four dedicated
app/web/DB/Redis users. It atomically replaces only its own credx_uat2 table, never
flushes the host ruleset. App/frontend/fake-worker units additionally deny public IP
traffic and IPv6 socket creation. Their ExecStartPre checks that the fixed certificate proxy responds,
then requires an explicit OS permission denial for a public TEST-NET address;
a timeout cannot pass. No live financial endpoint is probed.
Failure to install the scoped nftables policy or meet the runtime probe refuses
startup. IPAddressDeny alone is not treated as proof: see the systemd resource-control
documentation, https://www.freedesktop.org/software/systemd/man/systemd.resource-control.html.
Backend/worker share only UAT2 synthetic artifacts. Frontend gets its own cache.
Postgres/Redis have separate data/identities and localhost-only cgroup policy.
Non-superuser application DB role cannot run privileged filesystem/network operations.
Redis runtime CONFIG/module/replication/migration commands are disabled.
Separate journal namespace caps logs128MiB/7days; status shows disk use. System
resource limits bound each service. Time check requires active timesyncd, synchronized
state and successful diagnostic output after up to60seconds initialization.

## Build and verify

`deploy/uat2/native/build.sh /new/absolute/output` requires clean source,
Linux x86_64, Python3.12 and Node22. It creates an offline wheelhouse, actual Next.js
standalone artifact using the existing frontend packager, application source archive
and SHA256 manifest. Public UAT2 origins/badge/build stamp are set; no runtime secrets
are supplied. Native artifact output is not built from Mac binaries. CI verifies the
build; only tiny evidence manifests are retained by default, not large dependency
archives. A later approved transfer must use a verified administrative/package route.

`python3 deploy/uat2/native/ctl.py inspect-bundle /bundle` validates fixed filenames,
platform, source and hashes without starting anything. Transfers require an approved
route and exact source review; checksums alone are not proof of trusted provenance.

## Future approved setup and deployment

After exact resource/budget/security approvals, establish the root-owned0600
identity.json from its template with the new instance ID. Commands verify IMDSv2
account457945009677, regionap-south-1 and instance ID; original/helper/production
IDs are excluded, and existing production paths refuse co-location.

`prepare-host.sh` creates only the named UAT2 identities/directories and initializes
a separate PostgreSQL cluster, without installing packages or starting the app.
User/role creation and loading the UID-scoped firewall policy are exact action-time
security gates, not commands to run now.
Resolve independent backend/frontend/barrier config using the mandated
aws-secrets-manager skill and asm-exec; both are still unavailable. References are
templates, not fabricated values. Do not retrieve/copy production secrets or
substitute an invented secret command. DATABASE_URL must select the dedicated
app role, localhost5542 and credx_uat2 database, with URI-encoded password.

`ctl.py validate /etc/credx-uat2` rejects unresolved references, real adapter config,
shared signing material, non-UAT2 endpoints and permissive file modes, without
printing values. The independent GIS client authorizes exactly https://uat2.cred-x.in;
no Google redirect callback or production/Sheets client change is required.

After role/database creation approval: `ctl.py initialize /bundle` installs the
release offline, validates units, starts only DB/Redis/certificate proxy and creates
the UAT2 app role/database through SQLAlchemy administrative DDL. It never creates
an application login/profile. Only verified owner Google sign-in does that.

`ctl.py deploy /bundle` validates host/config/platform/hash, checks disk/time,
installs offline, stops app services, takes a UAT2-only backup, runs native Alembic
with the dedicated venv/DB, switches the source pointer and starts services with
bounded readiness. The owner's native-deployment selection is applied to this
UAT2 migration path; the repository's Docker-only migration rule remains unchanged
for existing Compose/production workflows. No production release script is invoked.

`ctl.py status`, `start`, `stop` operate only credx-uat2-* units. Stop preserves all
data and does not stop EC2/storage/IPv4 billing; stop the approved dedicated EC2
instance separately through the verified account/instance route. No exact shutdown
latency/billing guarantee is made and no cloud timer infrastructure is added.

`ctl.py backup` creates private dump+checksum+prior-source metadata.
`ctl.py rollback /var/lib/credx-uat2/backups/uat2-TIMESTAMP.dump` stops app services,
restores both schema/data and the recorded prior release, then checks readiness.
Failed restores leave the app stopped. Image/source reversal alone is not schema
rollback. Test this on native host before acceptance. No automatic data deletion.

`ctl.py reset empty|populated` resets only synthetic US snapshot rows after owner
Google login. Match UAT2_FIXTURE_STATE in backend.env and restart backend for India/
dashboard state. No reset grants access. Profile/preferences remain actual app routes.

## Outstanding gates

Exact fresh resource/subnet/admin and transfer route, current prices/window/retention,
mandated secret tooling, external DNS control, independent Google client and approved
barrier credentials are still prerequisites. Native Linux unit/confinement/live HTTPS,
owner browser login, UI screens, lifecycle/rollback and production before/after health
remain acceptance work. Local tests/CI packaging do not establish live readiness.
