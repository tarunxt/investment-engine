# Current UAT2 decisions

Current execution authority is CURRENT_SPECIFICATION.md and stages/00–20 from the newly supplied UAT2 revision. The exact prior decisions and evidence are preserved at history/DECISIONS-pre-uat2-pack-137fce50.md.

| Decision | Current rule |
| --- | --- |
| Active environment | Existing https://uat2.cred-x.in stack; verify, do not rebuild/reprovision |
| Readiness | Revised 00 UAT2 READY gates deployment. Old UAT is deferred and not a dependency. Preserve valid checks; complete only outstanding/invalidated ones |
| Current work | Reconcile Stage 01/PR #1240 into active UAT2 PR #1241; only documentation synchronization now. Preserve runtime/guards/code/migrations/preview |
| Stage scope | Stage 01 baseline;02 ownership;06–08 module policy/lifecycle/UI;20 cutover preparation only. Handoff overlap is not completion proof |
| Acceptance | Code, CI, deployment, UAT2 verification, owner review and external approval are separate states; user reviews deployed Stage 01 before 02 |
| Identity | Exact verified owner admission before profile/session, barrier across pages/assets/API/WS, independent host-only sessions; no synthetic public UAT2 accounts. Production Google signup fixes preserved |
| Simulation | Fake broker/AI, synthetic data, private mail/export sinks, no live integrations/orders or production data/credentials/runtime |
| Budget/lifecycle | Preserve authoritative existing spending/shutdown/retention limits; pack grants no renewal or new paid limits |
| Remaining product decisions | Both Kite-mode approvals, launch products, capacity/cost ceilings and retention/legal policy stay unresolved as detailed in archived decisions; no silent scope reduction |
| User population | UNKNOWN pending admitted read-only evidence; never infer owner from fragments or assume only one legacy user |
| Production | Unchanged; no main merge/deploy, production migration or financial-flag changes |

Source findings previously verified in jobs HTTP ownership, WS authorization and global runtime/admin boundaries remain tracked in the archived decisions and requirement map. No security repair, module system or migration is claimed by syncing prompts. Recheck each when its numbered stage begins rather than duplicating work.
