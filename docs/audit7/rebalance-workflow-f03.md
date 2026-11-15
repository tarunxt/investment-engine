# REBALANCE-WORKFLOW-F03 local implementation

Baseline: da317a1097cef97089e3a745b9e20b4952af6a48 (origin/main).

Revalidation: backend saved holdings_market_value remains settled quantity × saved last price. Current basket kiteWeightContext and rebalance prompt already include T1; the threat prompt already explicitly distinguishes settled and exposure totals. No formula, snapshot, historical record, permission, order, or API change is required for the demonstrated defect. This change makes remaining inspected source labels explicit: saved snapshot summary/trend/detail and event/threat snapshot cards are settled; basket parameters/action popup and rebalance input value are exposure. Event input labels retain their existing settled-only meaning and inclusion rules.

Deterministic acceptance: 10 settled + 2 T1 at 100 preserves saved 1000; exposure is 1200; adding 300 margin yields assets 1500, with current weight 0.8. Zero settled, T1-only, zero exposure, missing/malformed and partial inputs are covered; source object remains unchanged.

Verification:
- 79/79 combined frontend tests: basket-display-calculations, rebalance-stage-inputs, rebalance-input-counts.
- TypeScript: npx tsc --noEmit passed.
- Actual basket offline Playwright fixture passed, including explicit exposure label/formula assertions, summary/detail popups, repeated opens, edits, keyboard and state preservation; zero external requests.
- Actual saved portfolio page offline Playwright fixture passed at 1180 and 390px: saved/loading/empty/failed/partial/disconnected states, keyboard/history navigation, explicit settled summary/trend labels. Synthetic screenshot inspected.
- 12/12 backend tests (test_zerodha_portfolio.py, test_portfolio_events.py, test_zerodha_threats.py) passed as unchanged copies in /tmp/a7-isolated-tests with the project tests/conftest.py excluded. These tests do not invoke providers or telemetry.
- Normal backend suite setup is blocked: the autouse telemetry fixture imports application-wide modules requiring googleapiclient; adding test_threats_holding_context.py additionally requires anthropic. This is an environment dependency limitation, not a demonstrated assertion failure. No baseline assertion failures established.
- git diff --check passed.

Source limitation: resolved Library source returned NOT_FOUND / HTTP 404 before invocation for /workspace/audit7-source and the one bounded retry /workspace/audit7-source-retry. No readable PDF bytes or hash verification were available. Work uses the exact source finding and preservation text supplied in the delegation; no claim of original PDF pixel inspection.

Acceptance limits: local synthetic acceptance only. No production browser/account verification, generated live report/PDF verification, broker refresh, paid execution or external exports. All stored values and financial policies remain unchanged. Generic dashboard aggregates outside the inspected rebalance/snapshot views were not redesigned. Source-matched live acceptance and publication remain with the sole integrator. Nothing pushed, deployed or published.

Changed implementation/test files:

- `backend/app/domains/zerodha/events.py`
- `backend/tests/test_portfolio_events.py`
- `backend/tests/test_zerodha_portfolio.py`
- `frontend/app/console/dashboard/_components/RebalanceWorkflowSections.tsx`
- `frontend/app/console/zerodha/_components/PortfolioSnapshotsPanel.tsx`
- `frontend/app/console/zerodha/events/page.tsx`
- `frontend/app/console/zerodha/threats/page.tsx`
- `frontend/components/BasketActionSizingPopup.tsx`
- `frontend/components/BasketDisplayCalculations.tsx`
- `frontend/components/PortfolioParametersTile.tsx`
- `frontend/lib/rebalance.ts`
- `frontend/scripts/basket-offline-playwright.mjs`
- `frontend/scripts/india-snapshot-discovery-playwright.mjs`
- `frontend/tests/basket-display-calculations.test.mjs`
