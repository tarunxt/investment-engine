# UAT2 acceptance

**UAT2 BLOCKED — no cloud deployment, usable preview URL or browser acceptance.**
The owner selected native systemd preparation on a fresh separate server. This
selection is not a resource/budget, security-change or production-deployment approval.

## Verified preparation

- Preserved main0c6e61e/#1236 and prerequisite385f618/#1235. Stage01 untouched/not
  integrated. Branch codex/uat2-owner-only-20261019; exact final source in PR history.
- 44 focused backend identity/runtime/Google tests PASS, including native loopback
  configuration, production-token rejection, nonowner provisioning/session denial,
  alternate-auth denial, fake order schemas and disabled unsupported modules.
- 10 native package/config/host-identity/unit/network-gate/failed-migration tests PASS.
  They use synthetic fixtures and mocked host operations, not a live native server.
- Earlier unchanged frontend:16 auth/BFF checks PASS, TypeScript noEmit PASS,
  local actual frontend production build PASS. Seven shared config/Compose checks
  previously passed. Python compilation, shell syntax and whitespace checks pass.
- Published earlier aa8e516483ed1f1fa5ae5eceb3ace97ccd0da974 had both PR workflows
  SUCCESS. New native CI job builds Linuxx86_64/Python3.12/Node22 bundle at exact
  head SHA, without credentials, deployment, role changes or firewall installation.
  New-commit CI results must be checked separately; do not reuse earlier green CI.

## Native preparation implemented

Dedicated users, ports, PG16/Redis configuration, reverse proxy and fixed Google
certificate proxy; scoped nftables and systemd confinement templates; independent
session/cookie config; actual-app badge/walkthrough; offline application/frontend/
wheelhouse bundle with source/platform/hash checks. Native deploy/status/start/stop,
initialization, synthetic reset and schema+data-aware rollback commands prepared.
Failed migrations leave app stopped and prevent ambiguous start/promotion.

No host users, roles, firewall policy, services or secrets were created by preparation.
Native Linux service/confinement, actual artifact runtime, migrations, restart,
rollback, disk/time and browser acceptance remain live prerequisites. Mac unit
checks do not prove native Linux runtime behavior. No production health change
is claimed from absence of production actions.

## Preserved Compose evidence — optional, not the selected server architecture

Existing Docker Desktop became available (Engine29.8.2, Compose5.6.0), without a
software installation or unexpected permission grant. Backend image source3246e14
built. Disposable backend smoke retry passed container-only migrations, backend
readiness, anonymous API denial, blocked direct egress, fixed certificate proxy,
dedicated fake-AI Redis/Celery queue, real-schema synthetic fixture reset and UAT2-only
backup/schema-data restore. No host ports or live identities were used.
Logs preserved: /tmp/uat2-smoke-v2.log.

Initial frontend container build failed on missing sibling JSON; packaging inputs
were corrected. Subsequent image build ended with Docker daemon EOF during backend
image export. It is NOT a passing frontend/container packaging result. Initial nginx
host-bind startup timed out and cleaned up; retry copied only public test config.
Logs: /tmp/uat2-container-build.log, /tmp/uat2-container-build-v2.log,
/tmp/uat2-smoke.log. Compose work was preserved, not used to claim native acceptance.

## Exact outstanding prerequisites

- Concrete fresh AWS resource/subnet/admin and approved package-transfer route,
  verified current costs, testing window, allowance and retention approval.
- Mandated aws-secrets-manager skill and asm-exec available, then separately
  approved independent UAT2 secret provisioning/access. No production secret reuse.
- External DNS control: Route53 showed zero zones; public NS are
  ns63.domaincontrol.com/ns64.domaincontrol.com. No records changed.
- Independent Google GIS client/origin and exact independent barrier access arrangement.
- Native host dependencies and OS enforcement, active time service, valid HTTPS,
  owner Google login and authorized nonowner test, protected pages/assets/API/sockets,
  actual synthetic UI screens, deployment/restart/rollback and production before/after
  health checks. No live Google-login result fabricated.

AWS CLI STS session is expired; no aws login attempted. Existing authenticated
Chrome console separately verified account457945009677 and Mumbai; SSM showed zero
managed nodes. Browser console access is not proof of an approved admin/transfer route.
Stage00 retention and stopped resources remain separate and unchanged.

## Native CI evidence update

On exact commit8c6cc634437ad8a5f02346fc009a89cfa4f4eed5, native isolated contracts
and full Linuxx86_64/Python3.12/Node22 offline package build/validation PASSED, with
a small manifest artifact retained. API migration workflow PASSED. The audit CI job
failed because its async tests lacked pytest-asyncio; a follow-up restores that test
dependency and adds lifecycle serialization/config-independent stop. Fresh follow-up
CI must be checked separately. No production workflow or runtime was changed.

## Complete artifact retention correction

The PR-only native package job now retains the entire deployable bundle for one day,
not just its manifest. It audits content before upload, downloads the retained copy,
rechecks checksums/content and performs an isolated no-index dependency installation.
A small verification receipt is also retained. This corrects availability of the
release payload; it does not authorize an AWS transfer, launch or credential change.
The earlier successful manifest-only builds remain historical evidence. Fresh
artifact ID, source, expiry and round-trip results are reported in the draft PR.
