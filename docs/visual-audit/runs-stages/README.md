# VISUAL-RUNS-STAGES-HIERARCHY

Source interpretation: native reviewer `/root/verify_remaining_visual_requirements` inspected actual PDF pixels and preservation maps, pages 112–119, of Library `libfile_e735fdf1e9f48191b47cf49a5af5b476` (SHA256 `99c8a31a06a854f1b7e8550eff6c79288713396ded6b211b315b138ad644ebf1`). This implementer did not access the PDF pixels. The implementation reconciles the reviewer's complete requirements supplied by the coordinator. Report furniture and illustrative sample values are excluded from product controls/data.

Preservation checklist:

- Existing market tabs, actual counts, Refresh, pagination and all historical rows remain in RunsPage; data loaders, partial-source failure disclosures and financial/API semantics are unchanged.
- Every grouped record defaults to Run summary, with dynamic identity, execution versus result quality, saved start time, actual last-refreshed time and Open Run link.
- Purple/pale-lavender keyboard-accessible views preserve the selected identity in URL parameters. Arrow/Home/End navigate tabs; Back and deep links restore the requested record/view.
- Stage evidence has all seven aligned columns and all six stages. Existing historical adapters/formatters preserve source-specific counts, missing values, durations, partial errors and measured currencies. No values are normalized against workflow summary data.
- Additional details retains saved output, prompt, stage, duration and error-detail actions. Closed dialogs perform no reads. Zero/missing INR cost retains the existing formatter's n/a convention; recorded USD evidence remains separately labeled.
- Diagnostics retains all linked child/retry runs and provider-job counts, group diagnostic link, saved group errors, both adjacent grouped records, failed execution and each missing stage's Not recorded status. Adjacent context is derived from complete existing grouped history, including across page boundaries.
- A single amber text notice per partial/unverified completed record explains execution versus quality. No report labels, live actions or sample run IDs were introduced.
- History remains compact at default scale; desktop ledger fits the content width. Narrow screens get a named, focusable keyboard-scrollable table. Local dark equivalents are supplied; no global density changes.

Validation:

- `node --test tests/portfolio-stage-history.test.mjs tests/full-run-history.test.mjs`: 21 passing tests, including 1180×757 with sidebar-sized content, 1920 and 390 layout checks, failed/queued/not-recorded/partial evidence, source isolation, empty history and failed read recovery.
- `node tests/runs-stages-browser.mjs`: hydrated component fixture verifies summary default, keyboard views, URL identity, Back, deep-link remount, exact prompt/output routes, duration/error dialogs opened and closed twice, error focus restoration and narrow keyboard overflow. Fixture backend returns synthetic read-only data; external network is blocked.
- `npx tsc --noEmit`; scoped ESLint; `git diff --check`.

Screenshots are actual rendered implementation using synthetic data, not production captures or source mockups: [summary](summary-1180.png), [stage evidence](evidence-1180.png), [diagnostics](diagnostics-1180.png), [narrow stage evidence](evidence-390.png). All desktop fixtures use 1180×757 and a 920px content area. The page-level application shell and live loading states were not browser-exercised; their loaders/controls remain unchanged. Independent comparison against the reviewer-accessible source remains for the coordinator. No refresh, provider job, trading action, merge or deployment was performed.
