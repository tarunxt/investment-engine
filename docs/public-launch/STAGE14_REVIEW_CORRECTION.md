# Stage14 risk and quantitative receipt correction

Preserved original candidate:2c8cb43d0f87bf2d73c43889f18a9bb4a667f4d9. Independent review /Users/tarunsingh/Documents/Codex/2026-10-20/task-7/stage14-independent-review.json reproduced two P2 faults under isolated synthetic mutation. No public exploit or live trade was established; runtime was and remains disabled. The containing local successor and external handoff pin the correction source. This document supersedes only the earlier candidate's claim of complete risk/receipt protection, not its retained evidence.

## Frozen and current risk

Every post-draft state now requires a nonempty, allowed, dictionary-valued frozen risk result and review digest. Clearing or malformed evidence fails closed; it cannot bypass the resolver. Fresh trusted risk must still be allowed and exactly match the frozen result and review/request binding. The final effect boundary additionally compares current approval/request to the original persisted dispatch snapshot, so rebinding risk/review/approval after claim cannot substitute a different approval. Redelivery remains blocked, with the same mandatory evidence checks. A final fresh risk/policy/connection check occurs before marking the basket complete.

Tests cover missing/empty/non-dict/disallowed risk and missing/forged review at approval, dispatch, after claim and redelivery; risk becoming disallowed with missing evidence; deliberate recomputation of a replacement review/approval after claim; and current risk becoming disallowed after the last fake fill. Legitimate deterministic risk paths remain valid. This is application integrity, not DBA-proof evidence or real-provider certification.

## Quantitative and attributable receipts

A receipt must be an exact dictionary with supported state, integer fill quantity, bounded nonempty broker ID, exact client reference and payload digest. `filled` requires the full requested quantity; `partial` requires strictly positive quantity below the request; `acknowledged`/`rejected` require zero fill. Boolean, float, string, negative, overfilled, zero-filled completion and unsupported states fail closed. FakeBroker now supplies leg identity and payload digest; there is no real adapter or fallback.

Broker IDs cannot be reused for another leg/intent in the same owned account. Existing persisted receipt wrappers and fill fields are checked again at every fresh boundary. A dependent buy requires actual full quantitative completion of each prerequisite leg, and final basket completion requires every leg to be coherently filled. Malformed receipts record unknown and cannot advance/retry; partial and rejected outcomes stop the basket. Duplicate delivery never calls the broker again. Valid acknowledged/partial/rejected and fully filled synthetic paths remain tested.

Regressions cover the exact zero-filled sell reproduction, incomplete/invalid/overfilled quantities, mismatched IDs/references/hashes, malformed wrappers, forged stored fill values, duplicate IDs within a basket and across intents, and one-unit partial impossibility. Tests use exact FakeBroker plus isolated fault injection; no actual order occurred.

## Evidence and pending gates

152 focused tests and410 combined regressions passed with zero skips, including65 added cases.153 native and8 safe harness tests plus5 baseline tests are rerun for the final local successor; exact results are pinned externally. Existing migration/controller/frontend/login code is byte-unchanged by this correction, except prepared CI's expected test count (159=152local+7PG). No frozen historical gate is weakened. Original failures and original candidate remain preserved.

Actual PostgreSQL seven and Linux twenty cases, fresh exact-head CI/source/artifact/offline audits, independent re-review and permitted browser verification remain unrun/pending. No previously denied socket bind was retried. No publication, deployment, activation, provider call, real export/send, infrastructure/security/credential change or Stage15. Existing UAT2 source31ecd3fa, owner-only simulation, disabled analysis, US$10 allowance/manual21:04:13IST stop and26October retention remain unchanged. Final local candidate completion is not live acceptance or activation approval.
