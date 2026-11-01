TRUST-US-PARSER-COVERAGE — 2026-11-01T06:20:19Z

Baseline inspected: origin/main 8212f9e93772a8f5a91f3f782640aeeff0fe7cc8.
Synthetic actual-component browser fixture only; all external requests blocked.
No live records, providers, calculations, source text or financial values changed.

Before/after: 1440×1000 desktop at device scale 1 / default 100% browser zoom;
390×844 narrow layout. PNGs are full-page captures. Inspected actual pixels.
Keyboard Tab reaches controls and Enter activates the focused control. Existing
horizontal table scrolling is retained at narrow widths; no document overflow.

Final labels: Holdings parse status; Holdings parsed; ACME · Display name needs
review; Market-context extraction: Incomplete or unavailable. For extracted rows:
Market-context extraction: 1 index rows extracted; coverage is not verified.
An empty extraction no longer asserts absence of indices in the source.
Reconciliation retains snapshot $110.01, parsed $110.00 and delta $0.01.
Raw fixture includes Reports before Acme Example Company and S&P 500.

Verification: 16 browser fixture checks passed, 0 failed. Baseline screenshots
captured separately. Targeted ESLint and TypeScript --noEmit passed. Fixtures cover
success, mixed-success/name review, optional index blocks, missing index data,
confirmed empty history, initial loading, pending selection retaining old detail,
and a failed detail read retaining raw data. This tests presentation props, not
production response ordering or parser/backend changes. No full production build,
live verification or screen-reader audio test performed. Status roles verified in
browser DOM for extraction/loading. Next client-component guide read locally.

Run: cd frontend && node scripts/trust-us-parser-coverage-offline-playwright.mjs
Before: PARSER_BASELINE=1 node scripts/trust-us-parser-coverage-offline-playwright.mjs

Publication: sole batch integrator owns merge/deployment. No deployment performed.
