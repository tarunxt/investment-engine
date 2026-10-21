# Stage11 local requirement map

Canonical title: **Repair INDmoney imports and financial data integrity**. Exact complete specification remains stages/11.md. Local execution approved by owner at20October2026 18:06:46UTC, relayed by parent. Actual worktree created18:08:01UTC: task-3/stage11-indmoney-integrity, branch codex/stage11-indmoney-integrity-local-20261020, base f30db4e4bcdb3709371213b3daa907db8887c9ea. Parent records Stage10 acceptance; executor deployment/browser evidence is task-3/uat2-stage10-deployment.json. Original ledgers are historical, preserved below new checkpoints.

Read-only upstream check: main0c6e61e524c7a87c7b9ea79342f17b14a45e97a1; PR1240 OPEN, branch codex/stage01-preview-recovery-20261019, head ddefd7306003dc8e4e662d3b88abe167da77f036. Current base preserves Google fixes and verified Stage01 work. No remote changes.

| Requirement | Current implementation / gap | Local change / verification |
| --- | --- | --- |
| Trace Reports name and return-sign mismatch | service.py selects longest preceding label as name; daily summary independently parses dollars and percentage; holdings enrichment can normalize sign | Filter known UI noise; retain raw evidence; quarantine contradictory/unknown period values instead of asserting one is correct. Synthetic parser regressions. |
| Preserve count/duplicate/quantity checks | snapshot_validation.py already rejects missing/nonfinite/negative qty, duplicate symbols and incomplete count | Reuse these unchanged inside new financial validation; negative and fractional tests. |
| Preview then explicit acceptance | POST /portfolio immediately stores data | Add owned preview/quarantine states to existing snapshot model, explicit digest-bound acceptance and immutable accepted references. No second owner/module registry. Direct legacy write must not bypass acceptance. |
| Template / provenance / versions | No source/parser/currency/FX/accepted metadata | Stable strict CSV plus paste input, source hash, parser version, as-of/currency/FX declaration, content digest and same-owner correction chain; one additive migration prepared, not locally applied via Alembic. |
| Accounting / identity / currencies / periods | Mostly parse warnings; missing values sometimes treated as0 | Validate totals, symbol/name, quantities and return denominator/sign; reject mixed/unsupported currency rather than convert; explicit uncertainty/warnings before acceptance. |
| Owner isolation / immutable history | Existing get/list keyed by current owner; no delete endpoint | Owner-scoped preview/accept and correction references, duplicate import constraint/CAS, audit-preserving old snapshots, cross-owner/race tests. |
| Recommendations only validated accepted data | Existing latest snapshot selected regardless validation quality | Accepted-only repository/dashboard selection and independent eligibility validation before scan/prompt; legacy rows remain visible but unverified. |
| Missing history / stale data UI | Chart current_value||0 creates falsezero point | Null-preserving chart gaps, age/currency/provenance/acceptance labels, no zero fallback; component tests. |
| Useful actual UI | Existing INDmoney paste card and snapshots panel | Extend real components, isolated synthetic local preview only; live UAT2 module remains disabled. No imitation frontend/provider connection. |

Code LOCAL CANDIDATE; local tests PASS (172 backend, 84 native, 10 harness, 8 UI, TypeScript/build and 18 real HTTP); CI NOT_RUN11; publication NOT_AUTHORIZED; UAT2 deployment/verification NOT_AUTHORIZED11; owner acceptance PENDING11; external/provider approval unchanged/disabled. No production, credentials, AWS, access changes, live providers, merge or Stage12.
