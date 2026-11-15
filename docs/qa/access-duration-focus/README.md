# ACCESS-Rebalance-Duration-KeyboardFocus

Started 2026-11-01 at approximately 04:19 UTC. Baseline: origin/main c7d4942e03a3d0be320195b11fbbf24c5e83b94c (Visual PR #1364). Implementation required: the duration component only listened for Escape. The ledger separately focused the first globally selected dialog and trapped a control list omitting summary, without background inertness. No source PDF pixels were inspected in this task.

Reproduced with the actual baseline duration component in the local fixture: opening by Enter left activeElement on `Open duration`; the new initial-focus assertion failed (expected `Close duration breakdown`). This is component fixture evidence, not a reproduction of the full authenticated production route.

## Change

`StageDurationBreakdownDialog` now portals its existing overlay to body and calls `useModalFocus(open, panelRef, onClose)`. The hook captures the focused invoking control once per open session, focuses the first dialog control, isolates body siblings with inert, locks body scrolling, contains forward/reverse Tab including summary, redirects attempted outside focus, handles Escape, restores previous inert/overflow values, and restores a still-connected opener. Rerendered onClose callbacks do not restart the focus session. A removed opener is safely skipped. The hook is for one active body-portalled modal; nested/stacked modal coordination is not covered.

Removed the competing global focus code and early focus restoration from WorkflowStageLedger. No other modal primitives were changed. Selector owners may reuse the new hook with a body-portalled panel ref and stable open state. Existing dialog role, aria-modal, accessible title and ID remain intact. Timing arithmetic, data reads, Not recorded values, provider/workflow behavior and visual classes are unchanged.

## Deterministic verification

Run from frontend:

- `node scripts/duration-explanation-playwright.mjs`: passes 21 combinations: fallback, loaded, failed, loading, empty, active and partial at desktop 1180×757 (100%), narrow 390×757 (100%), and desktop 1180×757 (actual browser zoom 200%, CSS viewport 590×378/379). Long accessible title, disclosure opening, read-back role/title/modal semantics, Tab/Shift+Tab wrap, programmatic background focus attempt, rerender, two specific invoking controls, Escape, Close, repeated open and missing opener all checked. External fixture requests are blocked; none occurred. Page errors: none.
- `node --test tests/automated-rebalance-popup-reliability.test.mjs`: 14 pass.
- `node --test tests/portfolio-stage-history.test.mjs tests/auto-rebalance-audit-persistence.test.mjs`: 37 pass.
- `npx tsc --noEmit`: pass.
- `npx eslint hooks/useModalFocus.ts app/console/dashboard/_components/StageDurationBreakdownDialog.tsx components/shared/WorkflowStageLedger.tsx`: pass.
- `git diff --check`: pass.

Focus sequence: opener → Enter → Close duration breakdown → Shift+Tab → How timing is measured → Tab → Close → Tab → How timing is measured → rerender (same focus) → Tab → Close → Escape → original opener. A second opener receives focus after its own Escape dismissal. Close also restores the original opener. Attempting to focus Threats & Guardrails prompt while open leaves focus inside the dialog.

`semantics-and-focus.json` contains per-case rendered accessibility snapshots and focus assertions. These snapshots describe browser accessibility semantics, not spoken screen-reader output.

The three PNGs show the synthetic production-component fixture with the timing disclosure expanded and focused. Browser zoom was set using Chromium's own settingsPrivate.setDefaultZoom. Read-back metrics: desktop/narrow DPR 1; enlarged DPR 2, innerWidth 590. visualViewport.scale=1, computed body CSS zoom=1 and transform=none throughout. No CSS scale or device emulation was substituted for browser zoom. Existing scrolling accommodates the long content; screenshots are scrolled to the disclosure after keyboard activation. Long titles retain the existing visual truncation and full accessible name.

## Limits

No production deployment, authenticated end-to-end route check, real assistive technology, Firefox/WebKit, nested-modal behavior, or additional responsive combinations were tested. No screen-reader certification or site-wide contrast/target claim. No orders, runs, refreshes, paid services, saves, or account changes were triggered. Parent owns integration and release.
