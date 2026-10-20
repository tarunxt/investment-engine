# Stage09 requirement and evidence map

09 · Implement dual-mode connection storage and adapters. Controlling text is the complete, unchanged decoded prompt in stages/09.md. Owner accepted Stage08 and explicitly authorized Stage09 at 2026-10-20 10:49:05 UTC. Base: 61ce447ba35f4db7cd06fd550c62557450247af3. Google baseline 0c6e61e524c7 and prerequisite385f618 remain ancestral. PR1240 head ddefd730 is ancestral and reused, not rebuilt.

| Requirement | Implementation | Verification / state |
|---|---|---|
| Owner-scoped dual mode, account, expiry, status, version | connections/models.py + service.py | Draft; new isolation/contract tests required |
| One consistent app/token binding, no fallback | encrypted authenticated claims; explicit AppMaterial/BoundToken; Zerodha adapter | Draft; both modes and mismatch denials required |
| Private user credentials, platform service | keyring, encrypted per-connection envelope, exact platform reference/version | Draft; redaction and no-copy tests required |
| One active account provisional; future multiple | partial unique current owner/provider; stable connection IDs | Draft; additive migration/index test required |
| Versioned rotation + recovery | CAS and transactional credential update | Draft; missing-key/stale/interruption tests required |
| Preserve legacy ciphertext | metadata-only backfill; explicit verified adoption interface | Draft; byte preservation and wrong identity tests required |
| Readiness both modes, managed activation approval | GET-only private metadata; approval reference required | Draft; no entitlement or financial permission granted |
| Runnable actual Mac preview | Existing Next/Auth.js/FastAPI harness to extend | Pending Stage09 fixtures/UI; Stage01's42 checks are NOT Stage09 evidence |
| Docker migration proof | Dedicated PostgreSQL container CI gate | Pending; fresh host check daemon socket absent |
| Reviewable delivery | Separate branch from accepted08; draft PR and exact-head CI | Pending; no merge/deploy authorized |

Code / CI / UAT2 deployment / UAT2 verification / Owner acceptance / External approval are separate gates. Stage09 currently DRAFT, all other gates pending. Stage10 authorization attempts/OAuth/onboarding and renewal/revocation UX are excluded. Existing Stage08 capability/recovery gates remain authoritative. No production/AWS/oldUAT/credential changes.

## Isolated successor checkpoint

The current parent-authorized continuation is task-3/stage09-recovery-successor on unique branch codex/stage09-recovery-successor-20261020-task3, based on fc4d513. It does not edit or publish the original branch/PR. Local 171 contracts pass; see STAGE09_SUCCESSOR_REVIEW.md for the exact recovery-test reconciliation, preserved pre-fix identities/signatures and publication/mandatory PostgreSQL plan. Code, exact CI, PostgreSQL, native artifact, UAT2 and owner/provider gates remain separate. No Stage10, application-policy relaxation or runtime change is included.
