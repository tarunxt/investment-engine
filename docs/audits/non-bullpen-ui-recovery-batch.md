# Focused non-Bullpen UI recovery batch

Base: main 2337a8b25ea06c45c2907e93db1a838c33a3b660. This ports four bounded presentation fixes from the reviewed candidate without importing its authentication, session, accounting, prompt-draft, provider, financial, or workflow changes. Implementation, release, and live acceptance remain separate.

| Finding | Change | Preserved behavior and acceptance |
| --- | --- | --- |
| VISUAL-API-RECOVERY-CONTROLS | Put scoped recovery actions beside their panel headings and align their button treatment. | The summary still refreshes both usage and trend, trend retry reads only trend, and daily refresh reads only the selected daily breakdown. Keep all columns, provider toggles, date navigation, currency/timezone and provenance text. Loading/error/partial/verified-empty states and request guards remain independent. |
| VISUAL-DASH-RECOVERY-SCAN | Render primary source availability/history once per Sources-and-freshness row, while preserving the valuation qualification. | Preserve all views, source times, browser-cache age, source controls, history destinations, masking, currency/FX warnings, totals, selected tabs and existing refresh handlers. Separate views retain their own relevant disclosures. |
| DATA-ERROR-20261102-01 | Pass the existing market to readiness and explain its current validation rule. | India missing snapshots remain allowed by existing rules; supplied India exposure and US snapshot checks are unchanged. Loading, missing, failed and ready context stays distinct from submission eligibility. Preserve unsaved prompt drafts. |
| DATA-ERROR-20261102-02 | Give Swing body and footer one read-state explanation; retain rows during refresh and describe failed retained reads. | Only successful reads can imply no matching jobs. Keep India/US filtering, totals, job links, provider failures, costs, partial output and keyboard table access. No request, selection or execution handler changes. |

The API, dashboard, Swing and readiness browser fixtures use actual components, application CSS and generated read-only data, with external requests blocked. Paired market and desktop/narrow states are exercised. Existing unit assertions are retained; the failure-copy test follows the more explicit recovery-action label. CI runs the focused unit and browser checks in its existing jobs. Numeric bundle limits and dependency lockfile are unchanged.

JOURNEY-AUTO-DETAIL-SCOPE and ACCESS-Rebalance-Inputs-NarrowContentHeight are investigated separately and are not included in this implementation. Canceled A6-06 and A10-002/003/004 are not restarted. No source-only or synthetic result is a deployed closure.
