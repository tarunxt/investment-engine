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
