# VISUAL-MAILS-HISTORY-HIERARCHY

Includes canonical prerequisite **STATE-Mails-History-FailedVersusEmpty** in this same implementation; no second task or duplicate state mechanism.

## Source and scope

Baseline: current remote main `1089c6f1c5dc01c6cb41be1da7b45e9e7a8b805b`.
The native reviewer inspected source PDF pixels (pages 92/95/96) and the complete mapping/prompt (pages 92–96), then supplied verified requirements to this worker. This worker did **not** see the PDF images: supported Library materialization of PDF `libfile_e735fdf1e9f48191b47cf49a5af5b476` and selection image `libfile_0d924221bd9881918bf2e207ee2d05a9` failed, including bounded retry. No further Library retries were made. Common scope is followed from the delegated preservation requirements; direct inspection of pages 1–13/148 is unavailable.

Only the sent-history presentation and its read-state prerequisite change. Recipient, mail preferences, send/test controls, sell controls, SMTP/provider endpoints, timestamp formatting, financial calculations, permissions, execution safeguards, page width and shared density CSS are preserved.

## Complete mapping read-back

| Source mapped item | Implementation / verification |
| --- | --- |
| Sent mail history | Same heading; named history region |
| Scope: every email sent through Cred-X SMTP, grouped by purpose | Existing subtitle retained verbatim |
| New mail types appear in All Cred-X automatically | Existing subtitle and all-history collection retained |
| Refresh | Same button, existing two reads, aria-disabled during either active read with a synchronous retry guard; keyboard Enter tested |
| One unavailable status; no empty conclusion on failure | Single amber alert above results; canonical condition uses loading/error/verified success, never empty inference from failure |
| Category / Displayed count | Compact two-column hierarchy, pale neutral heading, bordered white rows; row remains a category filter |
| All Cred-X | Preserved independently; actual successful response count |
| Run notifications | Preserved independently; actual category count and filtered records |
| Risk alerts & tests | Full label preserved independently; actual category count and records |
| Account & security | Full label preserved independently; actual category count and records |
| GitHub checks | Preserved independently; source-specific loading/error/counts and records; independent success remains usable during SMTP-history failure |
| Captured example counts 0/0/0/0/50 | Never hardcoded. Unknown source displays Unavailable. Successful counts retained through refresh/failure and explicitly marked cached |
| Existing empty message | Available only after successful verified-empty response, with no active load/error; category-specific messages retained |
| Empty-state condition / successful response prerequisite | Canonical state rule, tested success-empty followed by failed refresh and successful retry |
| Return to History unavailable; report state tabs | Report navigation only; not added to product. Five real category filters only |
| Scope boundary | Existing message rows, warnings, delivery remarks, run/provider data and sell audit retained unchanged |

The overview's combined risk/security example is not used. A single status region covers the selected source; populated success requires no redundant status message. Last successful rows survive failed refreshes with a stale disclosure. Request sequence guards prevent older reads from replacing newer results.

## Verification

- `cd frontend && npx eslint app/console/mails/page.tsx scripts/mail-history-offline-playwright.mjs` — pass.
- `cd frontend && npx tsc --noEmit` — pass.
- `node --test frontend/tests/mails-stage2-alerts.test.mjs` — 4/4 pass.
- `cd frontend && node scripts/mail-history-offline-playwright.mjs` — pass. Uses actual page, real application Tailwind/token CSS and local HTTP fixture; all application fetches are intercepted. Asserts no external requests or mutations.
- Actual renders at desktop 1180×757, device scale 1 / default browser zoom, and narrow 375×812. Checks loading, populated, verified empty, unavailable, independent partial sources, cached/stale rows and counts, error/retry/success, five filters, keyboard Home/End/Up/Down and focus, repeated open/close of delivery details, and browser back. Narrow document overflow and category bounds checked.
- Screenshots generated in `artifacts/visual-mails-history/`: desktop-loading, desktop-unavailable-partial, desktop-github, desktop-loaded, desktop-stale, desktop-verified-empty, narrow-unavailable. Desktop unavailable, stale and narrow screenshots visually inspected by this worker. All records in screenshots are local fixtures.
- No new dialog exists in this scope. Existing unrelated dialogs are unchanged; delivery details open/close tested.
- Live production interactions, mail/provider reads, sends, preferences writes, jobs and execution actions were not used for verification. Integration/deployment belongs to the coordinator.

## Integration note

Shared-file conflict: `frontend/app/console/mails/page.tsx` is also used by mail-preferences work. Changes here are limited to history state/read guards and the final sent-history section. Preserve other task edits when integrating. No shared stylesheet or dependency/lockfile changes.

## Trust and Recovery re-verification — 2026-11-01

Checked current fetched `origin/main` and HEAD `8212f9e93772a8f5a91f3f782640aeeff0fe7cc8` at 2026-11-01 06:19 UTC. The failed-versus-empty rendering fix remains present. Initial actual-component verification exposed one remaining keyboard regression: the native disabled Refresh button lost focus when a read began. Refresh now retains focus through `aria-disabled`; loading state and a synchronous in-flight ref prevent duplicate reads, including repeated Enter. No mail or preferences mutation was performed.

Verification completed 2026-11-01 06:21 UTC:

- Six Node tests passed: four mail regression tests and two API failed-versus-empty tests; zero failed/skipped.
- Actual-component offline browser suite passed: loading, failed initial read, independent partial sources, populated results, verified empty, cached results/counts, retry, retained category and Refresh focus, keyboard category navigation, repeated details expansion, narrow layout and browser back. All fetches stubbed; zero external requests, mutations or browser errors.
- New adversarial StrictMode fixtures settle the newer mail failure before an older mail success, and the newer GitHub success before an older GitHub failure. Neither older response replaces the newest state.
- Repeated Enter while Refresh is aria-disabled creates no extra reads.
- ESLint, TypeScript `--noEmit`, and `git diff --check` passed.
- Seven screenshots saved and read back from `artifacts/visual-mails-history/`. Desktop remains 1180×757, browser default zoom 100%, device scale 1; narrow remains 375×812. Desktop partial/unavailable and narrow stale/empty-cache screenshots visually inspected. Screenshots contain synthetic records only.

Shared-helper assessment: API summary and mail source-state lifecycles are currently distinct; mail has two independent verified collections and per-source sequence guards, whereas API summary has period-dependent data plus separate combined-provider cost state. A pure shared state classifier could be introduced in a separate refactor, but changing both lifecycles adds no safety benefit for this focused rendering/recovery verification. No common backend cause is inferred and no shared helper is introduced.

Release limitation: this worker prepares a focused draft PR only. The batch integrator owns merge, deploy and production verification. No live delivery inference, sends, test sends, settings changes, record deletion, schedule changes or production operations occurred.
