# Stage06 requirement and policy map

Accepted/deployed prerequisite05:10c5a2c1561e8d1cf0e5b54c5b53e89e0c564c95. User accepted and authorized06 on20Oct2026 05:17:35UTC: “ive reviwed it too. proceed”. Fresh signed-in UAT2 Jobs/Runs/Preferences checks passed on05, including persisted owner session and explicit Bullpen unavailable. Independent review and exact CI/artifact evidence remain preserved. Sole existing UAT2 deployment executor coordinates later deployment. No07 until new user review; review handoff will include the checks actually performed and 🟢 only for successful verified results.

Full stages/06.md is controlling repository specification; unchanged complete decoded p06 from the authoritative UAT2 HTML. Source/metadata inspection found no UserModule, canonical module registry or /me/modules implementation in actual baseline. Historical PR1240 is baseline-only, not an existing module system. Reuse current User/role/owner/auth/transaction infrastructure; create no duplicate identity/permission system.

| Requirement | Implementation target | Evidence target |
| --- | --- | --- |
| Ten stable module IDs | One immutable catalogue and capability/config schema, existing domain IDs preserved | Exhaustive IDs, unique/cyclic/unknown dependency validation |
| Independent policy axes | Selection, deployment availability, verified jurisdiction/plan entitlement, connection readiness, execution capability are separately represented | Selection does not create a connection, entitlement, role or execution authority |
| UserModule/versioned config | Additive owner-state and per-module records; typed schema-version1 config, unknown keys rejected | SQL constraints/owner isolation; corrupt/unknown state fails closed |
| GET/atomic PATCH/version conflicts | Owner solely from authenticated current User; one owner aggregate version and transactional updates | Stale/concurrent writes, all-or-nothing validation, no body-owner override |
| Disable-impact preview | Read-only current-version contract; effects and unresolved scheduling integration explicit | No deletes/cancels/exports; historical data/settings retained |
| Onboarding/defaults/backfill | Default-deny absence, no optional records/grants in first-Google-sign-in transaction; no migration blanket-enable | New/retried/failed concurrent sign-ins preserve one identity/profile and no optional grants |
| Shared policy boundaries | Fresh owner-bound HTTP/stream/worker/side-effect interfaces; unknown capabilities denied | All boundaries, current activity/version, owner mismatch and no external calls |
| Internal services independent from optional UI | Consumer's analysis policy is independent of standalone AI Studio/Scanner selection | Rebalance analysis with those UI selections disabled |
| UAT2/safety/delivery | Existing owner-only simulation, no public runtime or provider access; additive management API only | PostgreSQL migration/concurrency, local fake preview, exact CI/artifact, independent review/handoff |

Implementation assumptions: baseline has no verified jurisdiction/plan entitlement source. The default facts resolver must report unknown and deny operational capabilities; tests use explicitly trusted synthetic facts. It must never infer residence from email/timezone, invent a plan, inspect secret values, or treat a connection/selection as trading permission. UAT2 unsupported optional modules remain unavailable; registering the management API must not mount any disabled domain router.

Config schema-version1 contains only the explicit schema version and rejects unknown settings; operational domain configuration remains in existing domain models until separately integrated. No new strategy, financial settings or provider management controls are invented here. No cross-module UI selection dependency is imposed on internal analysis: AI Studio and Scanner are standalone surfaces. The catalogue validates explicit future dependencies without fabricating dependencies for currently independent modules.

Owner-aware backfill: no pre-existing verified module preference records exist, so all existing users retain data/roles/connections and no optional selections are inferred. Legacy bot flags, profile thresholds/theme/timezone or the owner's settings are not an opt-in migration. Default absence represents no optional modules for both new and existing accounts.

Stages07–08 integration ledger will name every existing HTTP, stream, worker, scheduler/cache/export/side-effect adapter that still needs enforcement. Stage06 does not claim every old handler is already module-enforced, rewrite unrelated domain logic, remove Stage05 operator restrictions or open a disabled capability.

Production, owner-only UAT2 allowlist, simulation adapters, US$10 total and stop21Oct2026 21:04:13IST are unchanged. No new user, live grant, credential, external provider action, financial execution or access expansion is authorized by selection storage. Migration/deployment requires exact evidence and the existing executor's current READY/limit checks. No07.
