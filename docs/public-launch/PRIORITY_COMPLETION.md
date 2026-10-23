# Priority completion: active implementation checkpoint

Recorded 23 October 2026, 20:24:43 UTC. This is newly authorized work from the
remaining-requirements audit, not a restart of a stopped historical worker.
Base: `a5658773cd4687b2ecae7f7efc43c3173822032d`, verified remote branch
`codex/stage18-release-rehearsal-recovery-20261023`. New isolated working branch:
`codex/credx-priority-completion-20261024`. Existing worktrees and user changes
were preserved by cloning the verified source and creating a separate worktree.

The installed application remains the previously qualified `c493e95acb82345d54288f4996c89b6931c26bcd`.
Its existing acceptance and CI evidence are preserved, not transferred to this
new candidate. No runtime, controller, credentials, permissions, network policy,
production or actual user data was changed.

| Order | Priority | Requirement | Actual state at this checkpoint |
| --- | --- | --- | --- |
| H1 | High | Guarded hosted owner-only workflow | Started: PostgreSQL-capable durable fake venue journal implemented and locally tested. Hosted composition, request facts, worker/scheduler wiring and owner walkthrough remain incomplete. |
| H2 | High | Complete scoped export and recoverable erasure adapters | Started: encrypted, atomic, reversible SQL erasure drill implemented on disposable fixtures. Canonical typed exports, shared/external stores, identity/backup erasure and reviewed retention remain incomplete/held. |
| H3 | High | Runtime, evidence, support and operations bindings | Existing disposable bindings inspected; genuine hosted binding remains incomplete. External notification sinks must stay disabled. |
| H4 | High | Both Kite modes and US-import linked browser acceptance | Existing c493 India/SQLite browser evidence retained. No new both-mode/US browser receipt claimed. |
| M1 | Medium | AI and private export integration seams | Existing governed fake pipeline retained; hosted/private destination adapters remain incomplete. |
| M2 | Medium | Remaining HTTP/BFF/WS/task/export ownership and concurrency matrix | Added five PostgreSQL adapter cases and a dedicated zero-skip CI gate. Local collection verified; actual PostgreSQL execution pending. Other matrix gaps remain. |
| M3 | Medium | Operational UX, exact-candidate review and Stage20 preparation | Existing runbooks preserved. Full newly reviewable hosted candidate and new owner acceptance remain pending. No public-cutover GO. |

## Implemented bounded milestones

`JournalBrokerFake` stores immutable synthetic receipt/trade evidence using the
existing SQLAlchemy outbox and a separate transaction. It supports PostgreSQL
without creating another service, schema or credential. Durable reference
uniqueness arbitrates concurrent acceptance. Exact binding, canonical leg,
receipt/trade quantities and hashes are checked on reconciliation. Accepted but
lost responses remain recoverable after adapter restart. The existing execution
state machine admits only the two exact fake adapter classes; no real provider
class is admitted. Existing global module availability and route guards remain
unchanged. This adapter is not installed in the hosted runtime by this milestone.

`RecoverableFixturePrivacy` composes the existing owner/request/retention/schema
and disposable-database guards. It atomically archives encrypted typed preimages
and executes the existing child-first deletion. Explicit restoration rechecks
the owned receipt and schema, inserts parents before children, rejects collisions
and records an audit entry. Audit/archive failure rolls back the whole effect
even when an outer caller catches the error and commits. Restoring executable
work requires a separate reviewed adapter; unsupported populated stores block
before deletion. The adapter has no route or worker registration, and the
existing scope denies production and UAT2 databases. No actual account erasure
or security setting change was performed. Complete erasure remains false.

## Verification and limits

- 171 local tests passed across the new adapters, retained execution/SQL privacy
  workflows and UAT2 policy/runtime suites, zero skips. A subsequent targeted
  recovery run passed all 15 cases after adding SQL-side preimage size bounds.
  Counts overlap and must not be added together. Local JUnit receipts are
  retained separately from public source; CI has not yet executed this candidate.
- First local collection omitted `PYTHONPATH=backend`; a privacy run omitted
  `ENVIRONMENT=test`. Both failed before effects and were corrected. A real
  codec defect rejecting SQLAlchemy schema-derived string keys was reproduced
  and fixed by normalizing only those trusted keys. Failed runs are not passes.
- Five actual PostgreSQL cases are prepared for the existing acknowledged
  disposable PostgreSQL16 fixture: concurrent fake acceptance; partial,
  accepted-timeout and preacceptance restart reconciliation; and recoverable
  SQL erasure/restore. Local collection is not PostgreSQL evidence.
- This Mac executor has no `docker`, `postgres`, `pg_ctl` or `redis-server`
  executable. The new PR Checks job must execute all 42 selected cases,
  including all five PostgreSQL cases, with zero skips/errors/failures.
- No migration is required: no models or schema were added. Existing outbox
  relays select their named topics; the new fake venue/recovery topics cannot
  dispatch AI, orders or notifications through those relays.
- The production workflow is triggered only by pushes to main or explicit
  dispatch. This task branch does neither. Other operational workflows and
  existing test gates were inspected and preserved.

## Exact open gates

H1/H2 milestones are partial, not completed high-priority requirements. Complete
the remaining implementation before any hosted deployment. Then require exact
CI/artifact review, current UAT2 READY/authorization limits and coordination with
the existing deployment executor through the parent. The attempted parent
progress message through the desktop thread tool returned `thread not found`;
no controller action was attempted. The parent receives this task's completion
report through the delegation platform.

Real Kite approval and validation, trusted residency evidence, legal retention,
real destinations and new owner acceptance remain separate external gates.
Neither fake tests nor an installed source file resolves those gates. Preserve
the accepted restricted owner walkthrough; request acceptance only for new
flows once the complete new candidate is actually reviewable. Stage20 remains
preparation only; production cutover, real orders and external sends are excluded.
