# AUTO-MODELS-SELECTION

Implementation for the Threats India model dialog on `/console/automated-rebalance`.
Other stage/portfolio dialogs and other shared-panel consumers retain their existing presentation.

## Source and interpretation

The native reviewer `/root/prepare_visual_task_excerpts` inspected actual PDF pixels
on source pages 21 and 30–37, including continuation pages 32/35, and read the full
preservation maps on pages 22–29. This implementer used the reviewer's complete
verified requirements and transcription supplied by the coordinator. This implementer
did **not** open the PDF: all supported Library transfer attempts failed. The images
in this directory are newly rendered offline application fixtures, not source-PDF
images or live production captures.

## Preservation checklist

| Source map items | Implementation and verification |
| --- | --- |
| Stage, Models count, web-capable selected, selected estimate | Existing stage title and all original count/cost computations remain. Summary displays their runtime values; no historical sample totals are hardcoded. The fixture's selectable denominator is 18, not the historical capture's 11, because the existing algorithm runs on the supplied fixture catalog. No reconciliation algorithm was added. |
| Zero-estimate caveat | Visible in every view: a displayed zero is not evidence a future provider run is free. Existing estimate-readiness behavior and INR calculations remain unchanged. Unknown/partial/stale estimates also covered by existing regression tests. |
| Six views | Summary, one tab per source provider, and Model mix templates. Provider names and inventories are runtime-driven, so future providers/models remain accessible. Continuation PDF pages do not create tabs. |
| Anthropic provider, 0/8 observed, estimate, provider indicator, model controls | Runtime count and selected estimate preserved in provider header. All eight mapped fixture rows rendered and asserted. Existing configured/compatibility/constraint rules determine disabled status. Six older fixture models are disabled with explicit, readable reason text; no production state inferred from screenshot dimming. |
| Gemini provider, 0/5 observed, estimate, provider indicator, model controls | All five mapped fixture names, including gemini-3-flash-preview, verified. Runtime counts/estimate and Search attached source capability retained. |
| OpenAI provider, 1/9 observed, estimate, provider indicator, model controls | All nine mapped fixture names verified. Search only if forced and gpt-4o-mini's used-web evidence retained. Radio behavior, existing single-selection semantics and existing handlers preserved. |
| DeepSeek provider, 0/2 observed, estimate, provider indicator, model controls | Both mapped fixture names verified. Can search, not guaranteed and flash's used-web evidence retained. |
| Model / Web capability / Estimate / Availability-state | Aligned desktop comparison columns; full model labels and availability reasons wrap on narrow screens. Capability derives from the existing source resolver, including Anthropic fallback truth, not a new inference from the PDF. Used-web and missing-sources evidence and previous cost remain. |
| Search and selection continuity | Search filters presentation only. Search, switching tabs and summary navigation never call selection handlers. Current selected keys remain owned by the caller. Clearing search restores every row. Fixture explicitly selects a different model and verifies persistence across views. |
| Reset defaults, Done, Close | Existing handlers remain. One fixed footer contains selected count, Reset defaults and Done. Header Close remains accessible; Escape also closes. Footer and last model visibility asserted on desktop/narrow. |
| History icon, history states and run links | Original history handler and all history rendering/URLs remain in place. Offline fixture verifies history empty state. Live history/API and actual Next router back-navigation were not exercised. |
| Model mix templates, Compatible models, Name and Save Model Mix, Edit, Delete | Original controls and callbacks moved to secondary view without changing compatibility, persistence, prompt/confirm or mutation behavior. Existing saved/system-mix rules still govern disabled Edit/Delete. Template selector now has an accessible name; disabled buttons use neutral gray. Save/Edit/Delete were not executed in verification. |
| Loading, loaded, empty, failed, partial | All rendered using local fixtures; error/retry disclosures retained. Genuine empty catalog now says no provider models, rather than perpetually claiming loading. Partial fixture retains prior catalog and visible stale/error disclosure. |
| Focus, keyboard and repeated dialogs | Modal portal, inert background, scroll lock, initial Close focus, Escape, focus return and forward/reverse Tab wrap. Tabs support arrows/Home/End. Repeated open/close and background inert restoration verified. |

Exact mapped fixture names are recorded in `results.json` and in the browser test.
They are test data only. Production catalogs/counts/estimates are never replaced by them.
No provider jobs, scans, trades, live selections, live templates, refreshes or deployment
were performed.

## Verification

From `frontend`:

```sh
node --test tests/stage-llm-selection.test.mjs tests/llm-internet-access.test.mjs tests/rebalance-readiness.test.mjs
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js components/shared/LlmModelSelectionPanel.tsx components/shared/ModelPickerDialogFrame.tsx components/shared/LlmModelMixControls.tsx tests/model-picker-browser.mjs
CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium node tests/model-picker-browser.mjs
```

The browser harness uses existing Next webpack, TypeScript, Tailwind and Playwright
dependencies; it extracts the **real** `StageLlmSelectorDialog` from the workflow
source and renders the real panel, frame and template controls. It substitutes local
catalog, history and FX functions, and blocks every non-local request. It does not
boot the whole authenticated app or validate live API responses. Set
`MODEL_PICKER_EVIDENCE_DIR` to change the default `/tmp/auto-models-evidence` output.

Focused regressions: **10 passed**. Types and scoped lint: **passed**.
Browser results are recorded in `results.json`; desktop is 1180×757 at device scale 1,
narrow is 390×844 with an additional 320×757 overflow check.

Linting the whole workflow file reports two pre-existing
`react-hooks/set-state-in-effect` errors and 22 warnings. The same two errors and
22 warnings were reproduced from the untouched base commit (original lines 2826
and 2936). They are outside this task's selector edits.

## Rendered screenshots

- `desktop-summary.png`, `desktop-templates.png`: default and secondary views.
- `desktop-{anthropic,gemini,openai,deepseek}.png`: provider views; `-end.png` proves
  lower inventory is reachable above the footer.
- `desktop-{loading,empty,failed,partial}.png`, `desktop-history-empty.png`: state evidence.
- `narrow-summary.png`, `narrow-templates.png`, `narrow-{provider}.png` and
  `narrow-{provider}-end.png`: narrow layout evidence.
- `narrow-320-anthropic.png`: additional narrow-width check.

## Integration conflicts

Shared-file touch points: one import and only `StageLlmSelectorDialog` in
`frontend/app/console/dashboard/_components/RebalanceWorkflowSections.tsx`.
Inputs/Stages/Duration/Prompt branches may touch the same large workflow file;
resolve by retaining their changes and applying only this selector's hunks.
`LlmModelSelectionPanel` adds an opt-in `organized` prop; its default presentation
and all financial/selection callbacks remain. The template control file adds only
an accessible selector label and neutral disabled-button colors.

Draft integration only: no independent merge or deployment.
