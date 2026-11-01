# Audit 8 style contracts

These four offline fixtures compile application CSS and mount production components
with synthetic state. They block external requests and do not call live providers,
submit profile changes, refresh production data, or place orders.

Run from `frontend` after `npm ci`:

```sh
node scripts/disclosure-states-offline-playwright.mjs
node scripts/audit8-shared-input-offline-playwright.mjs
node scripts/report-refresh-offline-playwright.mjs
node scripts/profile-helper-offline-playwright.mjs
```

The dedicated `Audit8 shared control and theme contracts` CI job runs all four.
Set `CHROMIUM_PATH` and `PLAYWRIGHT_CHROMIUM_EXECUTABLE` when Chromium is not at
`/usr/bin/chromium`. Evidence defaults to temporary directories; set
`DISCLOSURE_OUTPUT`, `A8_OUTPUT`, `REPORT_REFRESH_EVIDENCE_DIR`, and
`PROFILE_HELPER_EVIDENCE_DIR` to retain the synthetic images and computed styles.

## Scope and preservation

- Disclosure controls use the production component and extracted Zerodha call
  sites. Tests cover resting, hover, keyboard focus, expanded, disabled, invalid,
  disconnected, and unconfigured states. Semantic backgrounds keep their existing
  dark palette; only complete background class tokens match at rest.
- The actual Profile page and shared Input exercise transparent underlines,
  disabled fill, focus/invalid borders, boxed textarea, and synthetic save failures.
- Actual Run History and LLM Performance pages share the outline/small Refresh
  component. Tests compare computed appearance, loading and disabled behavior,
  duplicate prevention, failed refresh, keyboard retry, and interrupted refresh.
- The actual Profile helper uses the existing `text-xs` density floor. Tests compare
  the audited baseline helper with the current component, confirm the 11px desktop
  minimum, wrapping, disabled fields, synthetic success/failure, repeated saves,
  and reload during a pending save.

Every fixture exercises Light and Dark at desktop and narrow widths. The scenarios
named `zoom200` use CSS scaling or a half-width CSS viewport to exercise reflow.
They do **not** establish actual browser 200% zoom. Native browser zoom and deployed
live verification must be recorded separately before claiming full closure.

The Profile helper baseline is pinned to commit
`da317a1097cef97089e3a745b9e20b4952af6a48`; its fixture needs that Git object. CI
fetches full history. Private audit documents and account screenshots are excluded.
