# CredX UAT2

**Live restricted deployment; owner browser acceptance pending.**
URL: https://uat2.cred-x.in. Native systemd on one fresh dedicated server.
This is not production deployment or an old Stage00 pass.

## Source and provenance

Branch `codex/uat2-owner-only-20261019`; draft PR #1239.
Application/frontend bundle: `4a8e81ab16c0c141d1f84656afdf548b659de496`.
Deployment controller: `c72d41ad2bce465e5f3f5cdbae43693935c38eb3`.
The controller fixes Chrony detection, nginx runtime paths and sanitized-PATH
administration. Its tree matches local `f3ac5c94d8158be356560763e4571abbcaada98f`.
Application code remains the earlier fully CI-verified bundle. New controller CI
is queued; refreshed combined bundle acceptance remains pending. Do not present
an older green CI run as verification of a newer head.

Preserved baseline main `0c6e61e524c7a87c7b9ea79342f17b14a45e97a1` (#1236)
and ancestor `385f618` (#1235). Stage01 is not integrated. Coordinate its exact
tested source through the parent; no decorative module controls were substituted.

Application ZIP SHA256:
`4e7d3b73b80897006a0a5bc6c1ff3cb7b71adf07c7745b4593fba71fc124363e`.
Manifest SHA256:
`239be802082246ec6603ee45b06b528891e6fbab1025bef4f859a918ca51cde7`.
Deployment-tool archive SHA256:
`1b60bcb63ad4c450f8b06b219a2dc6cdadfc708fabfae00b979cecc500901beb`.

## Approved resources and access

AWS account `457945009677`, Mumbai `ap-south-1`:

| Resource | Identifier |
| --- | --- |
| EC2 credx-uat2 | i-0d1d4a0b841c98691, t3a.large, standard CPU credits |
| Canonical Ubuntu 24.04 AMD64 | ami-065d2b03fb493085a, owner 099720109477 |
| Encrypted 40 GiB gp3 | vol-049d81922bc8fc3a5 |
| Elastic IPv4 | 16.4.84.155, eipalloc-05f573b2b2e0e8e52 |
| Security group | sg-0e64d54bd06fde3eb |
| SSH public key | key-0349669b7441f0b72, credx-uat2-admin-20261019 |
| VPC/subnet | vpc-0204982d4e14723a9 / subnet-0bc9e22176cee7140 |
| Deployment role/profile | credx-uat2-deploy |
| New secret | arn:aws:secretsmanager:ap-south-1:457945009677:secret:credx-uat2-wsTPWG |

SSH 22 is restricted to verified operator 49.43.25.205/32; recheck before changing it.
Only 80/443 are additionally allowed. Database 5542, Redis 6479, backend 8002,
frontend 3002 and certificate proxy 18082 bind 127.0.0.1 only. No production role,
secret, database, token or environment was copied. The fresh role permits only
GetSecretValue on that exact ARN, conditioned on AWS MCP service use.

The registered reviewed AWS skill/wrapper is pinned to official AWS commit
9d76dd4494b7ff76105f52f5d59ae2180dc91289; wrapper SHA256
05a9f8164b63b286bcf88bf4223c95b799e0ecaada45ddcd805567f57b20299f.
Runtime resolution succeeded through unchanged asm-exec and AWS MCP using the
instance's temporary role. Configurations are root-owned mode 0600; values are withheld.
AGENTS permits CLI provisioning when MCP tools are unavailable. No direct secret
read CLI/SDK call or direct SMA access was used.

Six dedicated credx-uat2-{app,web,db,redis,certs,proxy} identities own isolated data.
UID-scoped nftables blocks app/data/worker external traffic; systemd also restricts
addresses and IPv6 socket creation. Only the fixed TLS-verified Google certificate
proxy supplies signing certificates. Runtime confinement checks passed.

Caddy Basic authentication protects all application pages/assets/APIs/WebSockets.
HTTP ACME validation is the minimal public certificate endpoint;80 otherwise
redirects to HTTPS. Google GIS uses separate client
833980592098-3ag94voqctj8p60ikkpg34065khbdpu3.apps.googleusercontent.com,
name CredX UAT2, origin https://uat2.cred-x.in, no redirect URIs needed.
Production/old UAT Google clients are unchanged. Backend permits only exact
verified email tarun.singh6893@gmail.com before provisioning/session/token issuance.
Host-only secure __Host-credx-uat2 cookies and signing keys are independent.

GoDaddy uat2 A points to16.4.84.155, TTL 600, verified against both authoritative
nameservers. Production apex/API/www records are unchanged. Let's Encrypt YE2
certificate verifies for uat2.cred-x.in, expires 2027-01-17T15:01:29Z.

## Start, stop, deploy, rollback

On this dedicated host, controller alias is `/opt/credx-uat2/control/ctl.py`.

```sh
sudo python3 /opt/credx-uat2/control/ctl.py status
sudo python3 /opt/credx-uat2/control/ctl.py start
sudo python3 /opt/credx-uat2/control/ctl.py stop
sudo python3 /opt/credx-uat2/control/ctl.py deploy /home/ubuntu/uat2-staged/bundle
sudo python3 /opt/credx-uat2/control/ctl.py backup
sudo python3 /opt/credx-uat2/control/ctl.py rollback /var/lib/credx-uat2/backups/VERIFIED_BACKUP.dump
```

Deploy validates identity/config/source/platform/hashes, installs offline, backs up
only UAT2, migrates only its DB, starts bounded services and checks readiness.
Rollback restores both schema/data and the recorded application revision. A
source reversal alone does not undo migration. A first-deployment backup has no
prior release and cannot be used as an application rollback. Repeat-deploy backup
and schema/data restore were exercised before owner login.

Stopping services does not stop EC2 billing. Use AWS console Stop/Start instance
on only i-0d1d4a0b841c98691. After EC2 start, run controller start; units are not
assumed to autostart. Keep original lifecycle deadlines after restarts.

## Owner walkthrough and synthetic reset

Open the URL. Enter independent barrier credentials from the protected local
owner-access.txt handed to the owner, then use Google as tarun.singh6893@gmail.com.
Never paste passwords, tokens or cookies into chat. Owner must perform interactive
credential entry and genuine Google sign-in. No live nonowner account was used.

Review /console/uat2 for available/unavailable workflows and source stamp, dashboard,
profile/preferences, India synthetic holdings and US portfolio. Actual US fixtures
are provisioned only after verified owner sign-in. Fake broker IDs begin SIM-;
AI is deterministic and free, email goes to a local sink, exports stay local.
Live brokers, Sheets, paid AI, scheduled jobs and Stage01 controls are unavailable.

After owner login, reset only synthetic US rows with:

```sh
sudo python3 /opt/credx-uat2/control/ctl.py reset empty
sudo python3 /opt/credx-uat2/control/ctl.py reset populated
```

For India/dashboard states set UAT2_FIXTURE_STATE=empty|populated in protected
backend.env and restart backend. Do not provision an owner/profile with fixtures.

## Cost and retention

Initial launch 2026-10-19T15:34:13Z /21:04:13IST. Approved 48-hour stop target:
2026-10-21T15:34:13Z /21:04:13IST. New-resource retention ends
2026-10-26T15:34:13Z /21:04:13IST. US$10 total allowance, not a technical cap.
48 hours compute plus seven days disk/IP/secret estimates US$4.15 before tax,
US$4.90 with assumed 18% tax. Rates: t3a.large $0.0493/hour, gp3 $0.0912/GiB-month,
IPv4 $0.005/hour, one secret $0.40/month. Transfer/API/tax/FX may differ. Stopped
retention with EIP is about7.70/month pretax or9.08 with that tax assumption.
No free-tier credit assumed. Actual billing is not yet available. Manual stop
can take minutes; verify stopped state. No automatic or exact-time guarantee.
Deletion/release at retention end requires its exact destructive-action gate.

Old Stage00 remains separate: original root vol-0820f7e4073a37848 retention only
until 20 Oct 15:00 IST; helper root vol-07d700a05ead8ed67 deletion forbidden. Neither
old server/disk nor production i-0b8ad0aebce8510cb was modified.
