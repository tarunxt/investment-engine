# Stage09 native controller repair — local candidate

Scope: native controller, confined schema helper/service entry point, focused tests
and documentation. Application/provider behavior, schema migrations, network rules,
identities and service confinement remain unchanged. No publication, CI dispatch,
host operation or deployment is authorized by this local preparation phase.

The published historical rehearsal at 60f3c7b8778243abc907cf96c45b21d0f1e938e9
remains preserved. Its positive proposed sequence is not proof of this new runtime.
Historical controller repro tests explicitly load application-source 6844989a55ea2408d6da7862fa07194079ff8b19.

## Implemented safeguards

- Private fsynced pending marker before standalone rollback stops or modifies anything;
  retained across failure/interruption and enforced by subsequent controller starts.
- Fresh v2 backup records source/manifest, custom-dump checksum, revision and full
  reflected public-table data/schema/sequence/catalog fingerprint. The exact backup
  must match the recorded deployment recovery point. Old receipts fail closed.
- Exact Stage09-to-Stage08 downgrade only after private encrypted binding export,
  fsync and checksum verification. Reuse the existing confined migration service,
  application identity and localhost restrictions; no new privilege or SQL interface.
- Atomic PostgreSQL restore, fingerprint check before promotion/start, and stop on
  normal failure. Unknown or partially migrated revisions remain blocked.
- Verification-only interrupted recovery. It cannot blindly repeat destructive work;
  mismatch requires reviewed recovery. Private exports remain UAT2-local.

## Local evidence and limits

31 native unittest cases and eight rehearsal-tool cases pass locally. These cover
actual controller orchestration with synthetic filesystem/process boundaries,
backup provenance, exact helper downgrade checks, failure/interruption, retained
marker blocking, and successful verified recovery. Python syntax and diff checks pass.
No real PostgreSQL, Linux systemd, sandbox or live database was exercised for this
repair. macOS has no available local PostgreSQL/Docker runtime. No Stage09 deploy
or Stage10 work occurred. This candidate is not accepted for live deployment.

## Publication and CI plan (pending parent approval)

1. Parent reviews exact candidate diff/SHA; separately authorize branch publication.
   Recheck workflow triggers at that SHA before push. Existing PR checks include
   native test discovery; production pipeline must stay untouched.
2. Run disposable PostgreSQL16 CI against the actual new helper: capture Stage08
   fingerprint, dump, migrate, insert synthetic bindings, preserve, exact downgrade,
   atomic restore and verify the same fingerprint. Run injected downgrade/restore
   failures and confirm actual controller never promotes/starts. Exercise helper
   subprocess/result provenance and Linux service sandbox in an isolated fixture.
   Existing historical rehearsal is retained separately and is insufficient here.
3. Independently audit bundle contents and exact source, test receipts and confinement
   diff. Only then present any separately required live operation confirmation.
4. Live gate must take a fresh backup of accepted Stage08 61ce447ba35f4db7cd06fd550c62557450247af3,
   verify its v2 receipt and retain that installed release. Do not use the old
   26508e84 backup. Live rollback/start/browser checks remain pending authorization.

Failure before database verification intentionally leaves recovery blocked. A
mismatching interrupted database needs a separately reviewed recovery procedure;
there is no force/skip flag or marker-deletion recovery shortcut.
