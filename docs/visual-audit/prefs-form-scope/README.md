# PREFS-FORM-SCOPE

Base: current `origin/main` at `1089c6f1` (PR #1344). Implementation is limited to
`/console/profile/preferences`; integration/deployment belongs to the coordinator.

## Change and preservation coverage

| Mapped item / requirement | Result |
| --- | --- |
| Settings heading and account description | Existing settings shell preserved |
| Preferences heading and application description | Preserved |
| Theme helper | Exact wording preserved; accessible description and existing readable text token added |
| Profile, Preferences, Platform Cost Drivers, Security, Activity | All five existing hrefs and labels verified in actual settings layout; no layout edits |
| Theme: Light; timezone: UTC; notifications: All notifications | Verified with local loaded profile; defaults and every existing option retained |
| Other stored selections | Local New York / None / System profile survives retrieval unchanged |
| One Update preferences action | Preserved, in one save row; existing pending disable and payload tested |
| Notification scope | Short separate-category explanation and keyboard-accessible Email categories link to existing `/console/mails#mail-preferences-heading` |
| Timezone explanation | Explicit illustrative UTC/IST conversion, without changing selection or schedules |
| Compact single-column form | Bounded form width using existing spacing/surface tokens; no cards or global density/container changes |
| Save failure, success and dismissal | Real form tested against local deferred API fixture; failure retains edits, success dismisses |

No profile/API implementation, financial logic, notification categories, permissions,
schedule, execution safeguard, or other route was changed. The test's API mutations
are in-memory mocks only. No production route or backend was accessed.

## Verification

- `npx eslint app/console/profile/preferences/page.tsx scripts/preferences-scope-offline-playwright.mjs` — passed.
- `npx tsc --noEmit` — passed.
- `PREFS_EVIDENCE_DIR=/workspace/prefs-evidence node scripts/preferences-scope-offline-playwright.mjs` — passed.
- Same browser fixture with `PREFS_PAGE_SOURCE` pointing to the exact baseline source — passed.
- `git diff --check` — passed.

Browser fixture bundles the actual Preferences component, account settings layout,
shared controls, actual Next Link and actual compiled global CSS. Only profile API
and pathname lookup are substituted. Chromium: 1180×757, DPR 1, default scale 1;
narrow 375×812. Desktop form width: before 919.02px, after 450.23px. Narrow form
bounds stay inside viewport (left 36px / right 351px) in both versions. Keyboard
focus and visible ring, helper associations, all account hrefs, loaded/nondefault
values, loading without writes, empty/partial/failed reads, mock save pending/error/
success, navigation to a local destination fixture and back, and repeated page
opening are covered. External requests: 0; browser page errors: 0.

Screenshots are local fixture captures, not production or PDF mockups:

| Viewport | Before | After |
| --- | --- | --- |
| Desktop | [1180×757](before-1180x757.png) | [1180×757](after-1180x757.png) |
| Narrow | [375×812](before-375x812.png) | [375×812](after-375x812.png) |

## Limits for coordinator

- **Source bytes/images blocked:** both the supplied PDF
  (`libfile_e735fdf1e9f48191b47cf49a5af5b476`) and selection screenshot
  (`libfile_0d924221bd9881918bf2e207ee2d05a9`) were prepared with the current
  Library skill and its two current transfer helpers. Supported helper downloads
  returned `download failed`, including the bounded retry with an explicit
  consumer-local destination. No local readable source bytes were obtained.
  Library read recovered the complete required page text (1–13, 101–104, 148)
  and selection-image description, plus image pointers that are not viewable
  through the available local-image route. Page 104 specifically reports its image
  unavailable. Actual source-page pixel inspection remains unverified. The change
  follows the exact supplied implementation prompt and retrieved preservation map;
  no unseen design evidence is asserted.
- **Existing shared narrow navigation overflow:** the unchanged settings sidebar
  uses a horizontal row wider than 375px. Reproduced on both baseline and changed
  actual layout; Preferences form itself fits. The screenshot's wider full-page
  width records this inherited behavior. Shared `profile/layout.tsx` is deliberately
  untouched to avoid conflict with parallel settings work. Coordinator should
  reconcile narrow account navigation once across settings routes.
- **Existing retrieval behavior:** initial profile read failures log to console
  and retain form fallbacks, with no distinct read-error/loading UI. Partial/empty
  profiles use existing UTC/all/light fallbacks. This presentation-only task retains
  that behavior; it does not manufacture unavailable/stale metadata. No stale
  timestamp exists on this form. No dialogs exist here.
- Mail destination interaction uses a local placeholder; source verifies the real
  heading ID. Production mail settings, Security/Activity destinations, and full
  authenticated console navigation were not exercised.
- Repository `.agents/skills` and workspace `.agents/skills` do not exist. Root and
  frontend `AGENTS.md` were inspected; installed Next Link docs were read.

Only this task's page, offline regression fixture, and this evidence folder change.
No shared-file edits or deployment are included.
