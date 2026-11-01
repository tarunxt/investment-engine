# TRUST-PORTFOLIO-TIME-SEMANTICS

Baseline: origin/main `8212f9e93772a8f5a91f3f782640aeeff0fe7cc8`, fetched 2026-11-01 UTC.

Actual React components were bundled with repository Tailwind CSS and rendered by isolated Chromium fixtures. All navigation/network responses are local fixtures; no providers, account data, imports, orders or production failure injection were used. Screenshots and JSON label readbacks include desktop 1280x900 and narrow 390x900, device scale factor 1, default browser zoom 100%, browser timezone America/New_York to detect accidental local-time formatting. JSON files contain capture timestamps.

## Final labels

- Capture time: 8:19 pm IST (UTC+05:30).
- Captured 20 Oct 2026, 8:19 pm IST (UTC+05:30).
- Save time not recorded.
- Price as-of not recorded.
- Historical date remains 20 Oct 2026, source Login / Manual Paste remains intact.
- Available Margin retains its label and value; US unknown Wallet remains an em dash.

The API snapshot contracts expose captured_at, but neither independent save time nor price-as-of metadata. No existing source price time was discarded or inferred. US captured_at may be supplied during manual entry, so it must not be relabeled as server ingestion/save time. No schema, backend, source record, calculation, currency or permission changes.

## Validation

- `node --test frontend/tests/portfolio-timestamp.test.mjs`: 2 passed. Real UTC/offset timestamp conversion across midnight; missing/invalid/zone-less timestamps remain unknown.
- `node --test frontend/tests/portfolio-time-browser.test.mjs`: 1 test traversing 28 isolated render cases (India/US, 7 states, 2 widths). Capture status role, historical dates, wallet unknown, narrow overflow and keyboard focus checked for populated views. Loading, confirmed empty, error, partial, stale and unknown-time fixtures use actual components.
- `node --test frontend/tests/us-snapshot-rendering.test.mjs`: 4 passed, including async historical selection, stale-response handling, keyboard tabs, failed and successful synthetic save.
- `npx tsc --noEmit`: passed.
- Targeted ESLint on all changed production files: passed.
- `git diff --check`: passed.

Before images/readbacks were captured before changing production files; after images/readbacks were captured against the implementation. Desktop and narrow success screenshots were visually inspected. Full fixture screenshots also remain under /tmp/portfolio-time-before and /tmp/portfolio-time-after in this executor.

## Limits

This is a presentation-only change. India fixtures exercise panel props; US existing regression tests additionally exercise asynchronous page behavior. Native screen-reader audio and live account/provider behavior were not tested. No verified independent price/save timestamp exists in current API schemas, so both stay explicitly unknown. No merge or deployment attempted; those are reserved for the batch integrator.
