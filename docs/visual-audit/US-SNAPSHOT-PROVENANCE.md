# US-SNAPSHOT-PROVENANCE

Scope: `/console/indmoney-us`, based on main `1089c6f1`. Draft PR #1352. No merge or deployment.

## Source attribution

The native reviewer inspected actual PDF pixels 79–81 and 86–88 and the complete maps/prompt 79–88 on 1 November 2026. The coordinator supplied that verified interpretation to this coding worker. This worker read the PDF extraction but did not personally view its pixels; earlier supported Library transfers failed. No further Library transfers were attempted. Implementation follows the supplied interpretation, not a claim of independent source-image access. The report's private masks, sample dates, audit headings and “NOT DEPLOYED” labels are not production content.

## Preservation checklist

| Mapped requirement | Implementation and fixture evidence |
| --- | --- |
| Saved US snapshot, Paste snapshot, Market and stage navigation | Three keyboard-operated shared Radix tabs; selected purple/white, inactive lavender/purple; neutral rounded workspace and white form/table surfaces. Both widths have full and viewport captures. |
| Manual tracking/no direct API, saved timestamp, separate parse status and purpose | One compact workspace header beside totals, always-visible manual/no-API explanation, metadata Source details disclosure, separate saved time and parse badge, amber parsed-does-not-mean-live strip. `source-details` captures expand the original workflow purpose and actual source/date. |
| Private portfolio values, holdings, allocation, returns, context and history | Existing source values, USD formatting, derived fallbacks, warnings, all ten holdings columns, sorting, symbol links, historical snapshot selection, top allocation/gainers/laggards, reconciliation, market indices and raw text retained. `saved-partial` full-page captures/readbacks show populated synthetic fields. Missing history values are no longer plotted as fabricated zero; numeric values and underlying calculations are unchanged. Chart points now support Enter/Space and the chart scroll area supports keyboard focus. |
| Import versus display refresh | One Import snapshot action opens the paste tab. Refresh displayed data uses the pre-existing GET endpoints only, preserves historical selection and saved timestamps, and labels retained data explicitly after read failure. Switching views performs no request or save. |
| Timestamp, textarea, guidance, count and Save Snapshot | Existing local datetime initialization and ISO conversion retained; copied-screen-time guidance, full-portfolio/holdings guidance, multiline input, live trimmed character count, disabled blank/saving button retained. Form is force-mounted while hidden, preserving unsaved text/time across repeated switches. `paste-empty`, `paste-draft`, `save-failure` and `saved-after-fixture-import` captures/readbacks cover these states. Only explicit fixture submit calls the local mock save. Partial status/raw text/reconciliation warnings survive the save. |
| Portfolio, Swing Trade, Threats, Events, Rebalance, Final Actionables; India/US for each | Local grouped Stage/Markets table retains all 18 real route links (stage label plus India and US for each row), using the existing route builders. Explicit current US/Portfolio context; the current Portfolio/US link uses aria-current. No static replacement of working destinations. Shared navigation files remain unchanged. |
| Loading/loaded/empty/failed/partial/stale | Loading remains loading, failed initial reads never assert a confirmed empty portfolio, empty state requires a successful empty overview, retained stale values/time remain visible after read failure, unknown trend values remain unavailable. Read retry restores loaded state. No hardcoded audit values. |

## Source-code schema inventory

No API, schema, backend, persistence or financial formula changes. Existing types and data remain intact:

- Snapshot summary: id, snapshot_date, captured_at, source, parse_status, parse_warnings, holdings_count, reported_holdings_count, indices_count, wallet_balance, current_value, invested_value, day_return_value/percent, total_return_value/percent. Identity/count fields continue to support history, reconciliation and tables; none were removed from the response.
- Detail: raw_text, market_indices, holdings, derived. All existing detail sections remain rendered.
- Holding: company_name, symbol, market_price, market_change_percent, invested_value, quantity, average_price, current_value, total_pnl, total_pnl_percent, portfolio_weight_percent, price_vs_average_percent. The existing ten-column table, compact allocation/gain/loss views and symbol links remain. `price_vs_average_percent` was not independently rendered by the baseline; it stays untouched in the schema/data.
- Market index: name, value, change_value, change_percent, raw_change_text. The baseline four-column index table remains; `raw_change_text` was not independently rendered and remains in source data.
- Derived: parsed_holdings_current_value/invested_value/total_pnl, profitable_holdings_count, loss_making_holdings_count, top_allocations, top_gainers, top_laggards, reconciliation. Existing derived totals/fallbacks and sorting accessors remain unchanged.
- Reconciliation: label, summary_value, parsed_value, delta. All four fields remain visible.
- Create request: raw_text and optional captured_at; trimming, local timestamp semantics, save failure retention and raw-snapshot handling remain.

## Validation and evidence

All 18 tests pass; scoped ESLint exits 0 with no warnings, and TypeScript exits 0. Exact commands, exit codes and test output are preserved in `us-snapshot-provenance/validation.json`. Browser back navigation from a local fixture destination returns to the actual page component; real Next router/server integration remains outside the fixture.

- `npx eslint app/console/indmoney-us/page.tsx app/console/indmoney-us/_components/*.tsx tests/us-snapshot-*.test.mjs`
- `npx tsc --noEmit`
- `node --test tests/us-snapshot-provenance.test.mjs tests/us-snapshot-rendering.test.mjs tests/portfolio-history-integrity.test.mjs tests/portfolio-stage-history.test.mjs`

The browser fixture bundles the actual page and components with React and actual Tailwind CSS, stubbing only API and Next Link integration. Every HTTP request is fulfilled locally or aborted. Synthetic data deliberately differs from audit example values. This is actual hydrated implementation evidence, not mockup imagery or a live production capture. Fixture saves do not reach any backend. Evidence captures use viewport 1180×757 or 390×757 at device scale 1; full-page images include offscreen preserved fields. Matching JSON readbacks record visible text, source timestamp, input values, route destinations and selected view.

Evidence directory: `docs/visual-audit/us-snapshot-provenance/` (and generator output `/tmp/us-snapshot-evidence-v2`). Main comparisons are `{1180,390}-{saved-partial,paste-empty,navigation}{,-viewport}.png`; source details, draft retention, stale read failure, loading, empty, failed, recovered, unavailable trend, save failure and explicit fixture import have separate captures.

Limits: independent source-to-rendered pixel comparison belongs to the native reviewer/coordinator. Fixtures do not certify production authentication, infrastructure, live account data or the complete Next application shell. No dialogs were introduced. No live refresh/import, provider jobs, scans, trades, messages, account changes, merge or deployment were performed. Exact remote CI remains subject to available GitHub access. Integration ownership remains with the coordinator.
