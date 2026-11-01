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
| Refresh | Same button, existing two reads, disabled during either active read; keyboard Enter tested |
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
