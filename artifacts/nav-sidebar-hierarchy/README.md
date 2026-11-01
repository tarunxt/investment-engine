# NAV-SIDEBAR-HIERARCHY

Base: origin/main 1089c6f1. Branch: fix/nav-sidebar-hierarchy. Draft PR: https://github.com/tarunxt/investment-engine/pull/1346. No merge or deploy.

## Source attribution

The coding worker did not view the PDF. Source interpretation is attributed to the parent thread's native reviewer, who inspected rendered pages 71, 72, 76, 77, 78 and all assessment/map text from pages 71–78 on 1 November 2026. The complete verified interpretation was supplied by delegation. No Library transfer was retried after that instruction. Earlier materialization failures remain documented: PDF libfile_e735fdf1e9f48191b47cf49a5af5b476 and selection image libfile_0d924221bd9881918bf2e207ee2d05a9 returned download failed, including the bounded consumer-local retry.

## Result

Consistent root/group/child row heights, quieter group headings, and one filled active destination accent. Expanded active parents retain colored labels/icons; collapsed active parents retain the filled location cue. Existing indentation, arrows and visible focus remain. Secondary All destinations opens a native modal directory with primary/active view controls, explicit return, pale blue-grey table heading, white separated rows, pale lavender container and purple active-view styling. The table derives routes/names/badges from the current configured navigation and preserves custom names/order. It includes account links in addition to the inspected inventory. Native modal behavior contains focus, supports Escape and restores trigger focus. Returning without navigation preserves current group expansion. Following a link uses ordinary routing and existing mobile dismissal behavior.

## Preservation checklist by map

| Source page / mapped item | Preservation and evidence |
| --- | --- |
| 73 Active Automated Rebalance | Correct aria-current and filled child; rebalance desktop/narrow screenshots; directory navigation and Back/Forward tests |
| 73 Portfolios expanded / Trading Bots and AI Studio collapsed | Existing expansion logic untouched; current user-selected state retained across directory open/close, not reset to capture state |
| 73 Portfolios disclosure | Enter/Space, named button, aria-expanded/controls, matching row height and child reachability tested |
| 73 Trading Bots disclosure | Same keyboard/focus and every child-link check |
| 73 AI Studio disclosure | Same keyboard/focus and Prompt Library/AI Models reachability checks |
| 73 Existing navigation layout control | Existing reorder/reset/name/order implementation preserved; no control removed; mode button remains available |
| 73 Group / Visible destinations / State | Kept as actual grouped sidebar and live disclosure/active state, not an audit table in production |
| 73 Portfolios inventory | India Portfolio, US Portfolio, Automated Rebalance retained |
| 73 Trading Bots inventory | Every current child retained, including badges and routes |
| 73 Market Scanner | Existing direct link retained |
| 73 AI & Automation | AI Studio and both configured child links retained |
| 73 Monitoring | Run History and Alerts & Emails direct links retained |
| 74 Data & Integrations | Database retained at /database; Sports Rankings and Integrations/API Connections additionally preserved |
| 74 Return to primary | Primary navigation button, explicit Return to primary navigation, Escape; repeated open/close and focus restoration tested |
| 74 Directory explanatory annotation | Audit-only inspected/capture/visited claims excluded from application UI |
| 74 Directory Destination / Route | Real two-column table, all rows generated from current config; narrow wrapping and horizontal clipping checks |
| 74–75 All 18 mapped destinations | Each corresponding current href checked in directory, all current root/child links independently reachable in primary navigation; see inventory below |
| 75 Footer limit | Compact existing account/footer implementation untouched; bounded account popup, keyboard/Escape/outside dismissal regression passed |
| 76 Primary navigation | Current width, labeled hierarchy, active cues, grouping, scrolling and layout control retained; no wide shell or icon-only collapse |
| 77–78 Directory | Recoverable secondary UI, purple/lavender view controls, table surface/separators; desktop/narrow start/end screenshots |

Mapped route inventory (all preserved): Automated Rebalance /console/automated-rebalance; Bullpen 007 REVIEW /console/bullpen-ai; Bullpen Sports SPORTS /console/bullpen-sports; Bullpen 008 SHADOW /console/bullpen008; Dashboard /console/dashboard; US Portfolio /console/indmoney-us; AI Models /console/llms; Alerts & Emails /console/mails; Copy Trader /console/polymarket-bot; Polymarket Direct DIRECT /console/polymarket-direct-bot; Prompt Library /console/prompts; Run History /console/runs; Sports Rankings /console/sports-rankings; Market Scanner /console/technical-setups; Bot Overview /console/trading-bots; Bullpen Live LIVE /console/trading-bots/bullpen-ai-auto-live; India Portfolio /console/zerodha; Database /database. Retired Google Sheets remains excluded. Existing API Connections and Profile/Preferences/Usage & Costs routes are also included.

## Validation and limits

Focused ESLint and TypeScript noEmit passed. Five navigation utility tests passed. Offline production-shell Playwright passed at 1180x757 and 1165x747 100%, 390x747 100%, and desktop/narrow equivalent 67% CSS viewports. It verifies all root/child/directory hrefs, matching row heights, single active fill, named headings, scroll, keyboard focus/Enter/Space disclosures, repeated open/close, Back/Forward, modal focus containment, Escape/return controls, preserved group state and preferences, compact bounded account panel, and zero external/profile/logout requests. browser-results.json contains measurements; screenshots are synthetic offline fixtures, not production data. The worker inspected rendered desktop/narrow directory and active-rebalance screenshots. Native reviewer pixel comparison remains pending.

Sidebar data is static: loading/empty/partial/stale/failure route-content states do not change it and were not separately simulated. Existing rename/reorder dialogs are unchanged; full dialog regression was not run. No financial/provider/account/security behavior changed. No global density or width change. Shared-file conflict potential: SidebarNavigation.tsx overlaps other sidebar work, but footer logic is unchanged; the directory is a separate component.
