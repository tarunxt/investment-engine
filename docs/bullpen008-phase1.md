# Bullpen 008 Phase 1

Bullpen 008 is an additive, shadow-only workflow profile. Bullpen 007 remains at `/console/bullpen-ai` and keeps its existing API, settings, scheduler, run, order and audit records. Bullpen 008 uses `/console/bullpen008`, `/polymarket/bullpen008/*`, `bullpen008:*` Redis keys, separate Celery task identities and dedicated database tables.

## Component-reuse inventory

| Bullpen 007 component or pattern | Bullpen 008 usage | Reused directly, generalized or extended | Reason |
| --- | --- | --- | --- |
| `BullpenAiPageShell` max-width, spacing and loading island | `Bullpen008PageShell` | Extended as a dedicated 008 composition entrypoint | Keeps the familiar shell while preventing the 007 composition from choosing an 008 mutation profile. |
| `Card`, `CardHeader`, `CardContent`, `CardTitle` composition | Identity, summary, monitor, wallet, settings and history sections | Reused directly | Preserves card shape, radius, border, shadow, heading and spacing. |
| `BullpenAutoRunStageOutputDialog` | Stage 1–4 immutable input/calculation/output popups | Reused directly and additively generalized for focus trap, Escape close and scroll lock | Keeps the 007 structured table/detail/raw-JSON visual language without duplicating dialog styling. |
| Bullpen worker-stage cards | Six-stage 3-by-2 monitor | Extended in an 008-only adapter | 007 assumes three fixed stages; a separate adapter avoids changing its stage rules while retaining its card/badge/metric pattern. |
| Bullpen summary metrics | Portfolio value, investments, cash and certified target | Extended with 008 data | Uses the same typography and information hierarchy with a deterministic-certificate metric. |
| Bullpen positions/event table pattern | Read-only live wallet positions and Stage popup rows | Reused pattern and shared structured dialog tables | The 007 investment table has 007-specific decision actions; a read-only table prevents accidental 007 callbacks. |
| Bullpen scan/schedule controls | 008 closing window, phrases, refresh and scheduler | Extended in an 008-only adapter | The composition explicitly supplies only 008 save/start/stop callbacks. |
| Bullpen run-history pattern | 008 runs plus labelled inherited 007 history | Extended read-only | New records link to 008 details; inherited records never expose edit actions. |
| Bullpen status badges, error, empty and skeleton states | All 008 cards and screens | Reused visual pattern | Preserves established colours, feedback, loading and failure semantics. |

New 008-only UI exists only for the six-stage monitor and profile adapter because the 007 components encode three-stage and 007 mutation assumptions. The adapter supplies the 008 workflow profile, API namespace, route namespace, shadow permission and callbacks explicitly.

## Phase 1 safety contract

- Stages 1–4 may read live market and shared-wallet data, call the configured provider, cluster markets and produce a deterministic target certificate.
- Stages 5–6 always render `Pending Phase 2` and are never dispatched.
- The task records `orders_created=0` and `orders_submitted=0`; the only 008 order endpoint is an authenticated `403` safety boundary.
- Inherited 007 history is labelled `Inherited from Bullpen 007` and is not copied into 008 tables.
- Settings are copied once from 007 into a dedicated row, then validated and saved independently.
