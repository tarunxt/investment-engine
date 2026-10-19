# Stage02 private API preview

Actual Next.js UI: http://localhost:56322/console/jobs . Synthetic backend:127.0.0.1:56323. Backend PID71004; frontend PID71005. These ports/processes were started and browser/API tested in the isolated Stage02 worktree; they are not UAT2 deployment evidence. Original Stage01 preview/worktrees and UAT2 processes remain preserved.

From /Users/tarunsingh/Documents/Codex/2026-10-19/task-5/stage02-private-ownership:

```sh
.runtime/python/bin/python scripts/public_launch/preview.py status
.runtime/python/bin/python scripts/public_launch/check_private_preview.py
.runtime/python/bin/python scripts/public_launch/preview.py stop
# After stop, selects new unused loopback ports and prints exact URL/PIDs:
.runtime/python/bin/python scripts/public_launch/preview.py start
```

The local .runtime/python link points to the existing isolated preview Python environment; it is not committed. Fresh checkout setup is documented in LOCAL_PREVIEW.md. Build first with preview.py build after installing the pinned backend/frontend dependencies. Node/frontend build passed locally; no static replacement frontend is used.

Sign in with usera@stage01.example.com or userb@stage01.example.com, password SyntheticPreview123! (disposable local fixtures only). Actual jobs list shows only that user's single completed synthetic job; open the row for its private response. Sign out and sign in as the other user. Opening the previous user's known detail URL shows Job not found. Search/count/pagination remain owner-scoped. The generic synthetic Run exists in the owner-scoped summary API; the existing category-based Run History UI shows no classified portfolio run for this generic fixture. No dummy run UI was added.

Actual FastAPI and BFF HTTP checks passed: anonymous401; separate A/B sessions; per-owner search/list/count/pages; known foreign and guessed IDs identical404; raw Authorization/X-User-ID cannot override the authenticated BFF session. Tokens/cookies were kept only in memory. Browser confirmed A#2/B#3, own B response and A#2 not found when B signed in. Detailed sanitized evidence: evidence/stage02-local-preview.json. Screenshot supplements are local under .runtime/stage01-preview/.

This harness exposes real auth/profile and read-only job/run handlers against its own SQLite file, and creates synthetic records through SQLAlchemy. All network/provider/email/order/Redis/AI/export actions remain denied. Create/cancel/replay behavior is tested separately through real HTTP/SQL with fake queue/cache adapters, not enabled in the preview. UAT2 uses actual PostgreSQL/Redis and its exact-owner barrier; private multi-user tests remain isolated locally/CI. UAT2 deployment and verification are separate pending states. Owner reviews deployed Stage02 before03.
