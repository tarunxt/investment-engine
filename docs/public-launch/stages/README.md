# Active UAT2 stage instructions

The complete decoded stages00–20 are synchronized from Library libfile_8c0887a3e4f88191b24fba523ef6959e, CredX-UAT2-execution-prompts(1).html, the 19 October UAT2 revision. Earlier pack libfile_3d327c4f41f08191bdb9321b87a8639a is superseded as execution authority. The source HTML was read, not rewritten. Supplied byte hash is c25d5b69b160b0a9228667d6374b17f5e6b135ac8e941f2eee7404a81e8f1449; this read-only text route did not verify original bytes.

Revised00 verifies existing UAT2 READY, preserving valid evidence, Google owner login, host-only sessions, PostgreSQL/Redis, simulation, recovery and current budget/shutdown limits. Older uat.cred-x.in recovery is deferred and is not a prerequisite. Local/CI work may continue while readiness is pending; actual deployment requires READY and valid existing authorization. UAT2 task owns live checks/deployment, parent coordinates acceptance. Stage02 waits for the owner's review of deployed Stage01. Stage20 prepares cutover only; no production merge or deployment.

Synchronizing instructions does not implement stages02–20. Check STAGE01_REQUIREMENT_MAP.md before interpreting handoff caveats as completed ownership/modules. Preserve existing code/migrations; no duplicate module registry or tenant system. Synthetic identities stay in private tests, not public UAT2 admission.

Archive: 01-pre-uat2-pack-137fce50.md is an exact copy of the previous active01 file. No previous00 file existed at that candidate; the historical shared-server00 prompt is preserved separately with provenance. Previous ledgers/plan are exact snapshots under ../history/. Historical UAT.md and UAT2 acceptance evidence are unchanged.
