# Module policy integration ledger

Stage06 provides selection storage and shared decisions. It does not claim that every existing domain handler is module-enforced. `operational_enforcement_complete=false` remains explicit. Stage07 UI and Stage08 enforcement require separately authorized work after acceptance.

| Stable module | Existing sources to bind in07–08 | Remaining boundary work |
| --- | --- | --- |
| zerodha_rebalance | backend/app/domains/zerodha | Owner-selected analysis, requests, streams, queued work and effects; preserve broker and confirmation gates. |
| indmoney_us | backend/app/domains/indmoney_us | Owner import/snapshot/analysis and queued effects. Manual import readiness does not imply execution permission. |
| bullpen_research | backend/app/domains/bullpen008, polymarket, bullpen_trade_analysis; frontend/app/api/bullpen-ai, universal-polymarket-scan | Research consumers must retain singleton/operator restrictions. Shared runtime remains unavailable to ordinary users. |
| bullpen_live | backend/app/domains/polymarket_auto_live | Attribute persisted work to owner/module/version and recheck immediately before orders; retain all existing operator, idempotency and financial safeguards. |
| copy_trader | backend/app/domains/polymarket | Separate capability from research/live; singleton access remains closed. |
| prediction_direct | backend/app/domains/polymarket_direct | Separate owner/capability and order-specific confirmation; unavailable runtime stays closed. |
| market_scanner | Existing scan entry points in Bullpen/universal scan | Standalone UI selection must not become a dependency of rebalance internal analysis. Verify actual consumer attribution before binding. |
| ai_studio | backend/app/domains/jobs, runs, prompts | Persist trusted consumer context before work; do not trust browser module IDs or infer a module from shared Job/Run ownership alone. |
| sheets_export | backend/app/domains/google_sheets; job/run export workers | Recheck owned destination, current selection/version, connection and effect permission at HTTP, dispatch and final write. No stored Google credential inspection in06. |
| sports_rankings | backend/app/domains/sports_rankings | Separate catalogue module read from global ADMIN maintenance and paid refresh; preserve Stage05 restrictions. |

Core Profile, Preferences, Connections, personal usage and safety activity remain available under active authentication and ownership without optional selections. Global maintenance retains administrator authorization. Existing frozen history and data are retained on disable.

The shared `ModulePolicy` HTTP/stream/worker/side-effect contract takes server-derived owner identity and current stored state. Resource ownership remains in existing domain tables. A decision must be checked fresh at delivery/dispatch/effect; cached prior allows do not authorize subsequent work. Stage08 must add any missing persisted module attribution to the existing resource model rather than invent a parallel ownership registry.

Entitlements currently have no verified jurisdiction/plan source, so operational decisions default deny. Connections and explicit execution/confirmation are separate server facts; request configuration cannot supply them. No permission is inferred from selection or an ADMIN role. No provider approval, paid operation, order, email, new grant or deployment is authorized by this implementation.

Stage07 owns selection/disable-impact UI. Stage06 preview exposes the real authenticated management API through the existing Next BFF; existing Preferences screens are preserved. Live UAT2 remains owner-only and keeps all optional modules unavailable; management API availability does not mount optional domain routers.
