# Stage14 requirement map

Canonical source: stages/14.md, same decoded Library execution specification. Base accepted31ecd3fa; source/owner acceptance reconciled in STATUS without rewriting historical receipts.

| Requirement | Implementation / verification |
|---|---|
| Durable immutable exact order/basket, owner/account/mode/version | order_intents models/contracts/service; strict normalized LIMIT/CNC cash-equity synthetic subset; per-leg digests/client references; any unimplemented order type fails closed |
| Separate draft/validated/review/approval/submission/outcome states | Service create/validate/review/approve/dispatch; leg states, broker receipt, fills/reconciliation metadata; no quantity substitution |
| Explicit authenticated payload-bound approval | Router uses existing get_current_user; server review digest + explicit confirmation action; owner-bound nonce/time/expiry/risk/connection hashes; task headers never identity |
| Exact basket approval / sequence | Every displayed leg and sequencing rule hashed; foreign/changed/extra/missing legs rejected; acknowledged sell cannot trigger later buys; no standing consent |
| Durable per-owner operation uniqueness | Unique(owner,key digest), existing canonical_digest, existing OutboxMessage transaction with approval; no parallel tenant registry or Redis authority |
| Dispatch/revocation boundary | Existing User/selection header and connection row locks, intent CAS-by-lock; committed submitting claim before I/O, recheck after waits; no blind retry after uncertain outcome; normal runtime absent |
| Legacy broker write paths | Zerodha3 HTTP submit routes and sync/async order transport fail closed; central require_financial_writes_allowed and direct CLOB inner path fail closed; Bullpen subprocess write fence fails closed. Full boundary inventory in STAGE14_LOCAL.md |
| Adversarial local coverage | test_stage14_order_intents.py, test_stage14_http_and_legacy.py; prepared disposablePG races and Linux matrix distinct from local tests |
| Additive migration / safe recovery | order_intents_001 after ai_limits_001; exact order-table pair validated; private order/outbox/spend preservation; child/parent cleanup and DDL one active transaction; pending markers/provenance/fingerprints retained |
| Existing integrity/budget/login gates | Existing Stage13 tests and older frozen controller runners retained; no Google/credential/data-boundary changes; runtime off |

No real broker runtime, credentials, order transport, notifications or exports are composed. Synthetic adapter approval cannot authorize production or live trades. Stage15 reconciliation/execution expansion is separate. No dummy UI is presented as implementation.
