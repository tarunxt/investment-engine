# Supported store closure and local browser gate

Work began 2026-10-23 22:59:30 UTC on a successor to e7a5709. The executor
disconnected at approximately 23:08 UTC before report creation/staging/commit.
The bounded read-only recovery after the parent's 23:09:33 UTC notice confirmed
HEAD e7a5709, unstaged prepared changes and absent report. No uncertain write was
blindly repeated. No old candidate was amended, published or deployed.

## Supported local contracts

New task packets persist only a typed job/run/user locator, never raw arguments.
Execution retains original digest/owner/module/current-policy checks and checks
the new locator against actual arguments. Export verifies the owned resource.
Old packets lack original arguments; a digest cannot reconstruct them. They
retain runtime compatibility and export with an explicit historical-resource hold.

New encrypted review consent packets add a searchable owner index, rechecked
against authenticated owner/consumed claims during export. New unlinked consents
are discoverable without scanning other tenants. Old unindexed, unlinked packets
need original keys or an owned reference; no historical discovery is fabricated.

Scan inventory uses actual persisted owned run IDs to derive page-cache roots,
and owned run source-v1 references to verify pack segment lengths/hashes. Trusted
caller directory descriptors, no-follow opens, regular-file/hardlink checks and
bounded reads prevent arbitrary traversal. No decompression, opaque content
export, foreign-directory scan, missing-data refetch or deletion occurs. A pack
reference does not establish exclusive whole-pack ownership.

Canonical audit bundles support a closed schema-2 metadata projection requiring
owned snapshot/run bindings, matching canonical/stable content hashes and closed
schema/source/lifecycle values. Shared references suppress the projection.
Arbitrary JSON/text and free prose stay withheld. Earlier generated XLSX adapter
continues to expose only exact owned producer-name metadata.

Seventeen actual legacy financial/operator/credential stores have explicit source
exclusion reasons and fail-closed tests. Generic recovery cannot revive external
orders/positions/capital/redemptions, role grants, schedulers or credentials.
Selected confirmed-order/spend fixture adapters retain their separate quarantine.

## Verification and dependent blocks

100 affected lifecycle/consent/store/recovery regressions passed, zero skips:
`credx-store-closure-regression.xml`. Privacy CI gate expands to 57 cases.
Independent review inspected actual code and ran 10 task/consent/scan and 20
blob/exclusion checks without another verified defect; counts overlap.

The prepared opt-in browser gate uses the real frontend walkthrough, installed
workflow routes, normal password/JWT login and no FastAPI dependency overrides or
preview routes. SQLite and fake task delivery are explicit; no hosted native-main
startup, Google, PostgreSQL/Redis or deployed UAT2 acceptance is claimed. The cold
source-stamped build and browser execution remain required evidence.

Remaining dependent gaps: old lost task arguments; old unindexed/unlinked consent
keys/references; unsupported opaque content schemas; deployed filesystem/cache/
backup inventory; the three retention/identity/backup decisions (not legal
compliance approval); publication approval, exact-source CI, actual PG/Redis,
safe UAT2 deployment and new owner acceptance. No real erasure or provider effect.
Full account export/erasure and full hosted High/Medium completion remain false.

## Recovered execution and rendered qualification

The first verified resumed write was saved at 2026-10-23 23:10:28 UTC as
704960e6dbd9af86c3ab6e91e0a4799b0e313341 (20 files). The bounded read-only
recovery occurred after 23:09:33 and before that write; its exact first-read
second was not recorded. The interrupted report/stage/commit had not executed.

Local browser repairs were isolated in d4cde43, a5256cf, 1ba263c, 74e0444 and
43fa499. They address one frontend origin, full disposable model schema, initial
connection readiness, accessible portfolio selection, the actual US option,
independent fake delivery handling, and exact returned basket identity. A stale
review approval in the intermediate browser attempt was rejected by the server;
the test now waits for the exact newly prepared intent instead of any button.
No application guard was weakened. Independent review found the delivery-batch
reliability issue, now fixed, and no further verified application isolation bug.

Exact tested source: 43fa4995a556be53b4275728d6ac0b4bcae1b5c6. Its cold frontend
build passed (53 pages). The actual rendered browser test passed in 73.28 seconds,
with four screenshots: both simulated Kite modes/source acquisition; completed
India analysis and exact fake fill; accepted exact US source; completed six-stage
US analysis. Worker error record was empty. A sanitized receipt is saved beside
this report in local-native-browser-evidence.json. Full local receipts/screenshots
remain outside Git; they were not published. The Google script was blocked.

The focused supported-store suite also passed 25 tests, zero skips, at
74e044475f8f44defd891dcf03a4878edea22b19; only browser test code changed afterward.
This overlaps the previous 100-case affected regression and is not additive.
The exact-source native order-composition matrix passed 13 tests, zero skips
(credx-native-order-matrix-43fa499.xml), covering filled, partial and both unknown
scenarios, worker-instance recreation, reconciliation and blocked redispatch.
Instance recreation is not a real process/Redis restart.

The prior paragraph calling the browser gate prepared is superseded by this
local result only. Full hosted completion remains false. The runtime is SQLite
with explicit in-memory delivery and actual installed service/worker classes;
there are no FastAPI dependency overrides or preview routes. This is not native
hosted entrypoint startup, real Celery/Redis, PostgreSQL, Google login or owner
acceptance. No Docker, psql or redis-server executable is available here, so the
prepared disposable PostgreSQL/Redis probe remains unrun.

## Final local implementation boundary

Supported typed task/consent contracts, bounded canonical metadata/file/cache
projections, stopped confirmed-order and held-spend recovery, and explicit legacy
live/operator exclusions are locally implemented and tested. Historical packets
without original task arguments cannot be reconstructed from a digest. Old
unindexed/unlinked consent needs original keys or an owned reference. Unsupported
opaque payloads need reviewed ownership/content contracts; a shared pack/blob
reference does not establish exclusive whole-object ownership or deletion rights.
Those dependent parts remain held, not silently counted complete.

The remaining release sequence requires publication permission for the exact
candidate, independent review and exact-source CI including PostgreSQL/Redis,
then the existing deployment owner's safe UAT2 gate and new owner walkthrough.
The earlier five-commit publication request remains pending and does not cover
these successors. No remote/server/security action, actual erasure or provider
call occurred during this continuation. Existing candidate refs remain intact.
