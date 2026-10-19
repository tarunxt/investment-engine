# Stage 01 scope recovery — blocked on source

19 October 2026. This is a recovery report, not a Stage 01 specification or completion claim.

## Authorization and current state

The user authorized Stage 01 development and isolated local/CI testing while Stage 00 live acceptance remains **BLOCKED**. That instruction supersedes the historical prohibition on starting development only. Stage 00 PASS remains a prerequisite for Stage 01 UAT deployment. No merge, deployment, AWS launch, disk movement/deletion, access change or retention extension is authorized here.

An independent checkout was created on `codex/stage01-scope-recovery-20261019` from fetched `origin/main`, `0c6e61e524c7a87c7b9ea79342f17b14a45e97a1`. Existing user edits in the source checkout were not copied or modified. The deployed Google-login commit is the base itself; no auth code was changed.

## Sources checked and findings

- Read applicable root AGENTS.md. The explicit draft/no-deploy instruction overrides its default release behavior. No `.agents` or `.codex` directory exists in the new repository root.
- Read relevant preserved Stage 00 files under the 18 October task-4 workspace, including readiness/recovery records and the pinned Google-signin source receipt. They were inspected read-only.
- Read `docs/public-launch/stages/00.md`, STATUS, RELEASE_GATES and the Stage 00 audit from preserved preparation sources and/or the fetched integration branch.
- Fetched all advertised repository branch history. `git log --all --name-only --format='' -- docs/public-launch` lists Stage 00, status, UAT, retention, auth-design and evidence documents; the only stage specification is `stages/00.md`.
- `git log --all -G 'Stage 01|Stage01|stage.?01' -- '*.md'` identifies Stage 00 preparation/gate changes (`1434845b`, `f2dcaa47`, `6672b3da`, `5e080963`, `a645599b`). These do not supply Stage 01 requirements.
- The connected GitHub API independently lists only `00.md` in `docs/public-launch/stages` on `codex/credx-public-launch-uat`. PR #1237 has no returned discussion comments.
- Root ROADMAP.md describes the equity research pipeline (CP checkpoints and research stages). It does not define public-launch Stage 01 and must not be substituted for the missing agreement.
- Personal Context search returned “Personal context is unavailable for this conversation.” The available local `.codex/memories` directory is empty. No runtime-supplied memory summary/path containing the agreement was available; raw session storage was not read. The parent thread summary API returned no turns.

**Result:** The actual agreed Stage 01 feature scope, exclusions and acceptance criteria could not be recovered. Implementing a guessed tenant/auth/module stage would violate the requested scope boundary. Feature implementation is pending a recoverable agreed specification or its exact source reference. This is a missing-source blocker, not a permission denial or uncertain execution outcome.

## CI inspection

At the pinned base, `deploy.yml` runs on pushes to `main` or explicit manual dispatch; manual production dispatch requires `refs/heads/main`. It is not triggered by this branch push or a PR. Production inspection workflows with push triggers name `fix/sports-ranking-live-validation` and `codex/fix-ranking-errors`, not this branch. Remaining operational workflows are manual dispatch. No workflow was dispatched.

`pr-checks.yml` runs on PR/manual events with read-only contents permission and hosted test/build runners. Its database jobs use disposable PostgreSQL/Redis service containers. `api-attempt-migration.yml` is path-filtered PR testing inside a Python container with disposable PostgreSQL. No production deployment trigger correction was identified for this branch name. Full feature-specific test isolation must be reviewed once the actual Stage 01 scope and test changes exist.

## Verification and next step

- Local: scope/history/trigger inspection and Google-login baseline comparison completed; `git diff --check` for this report.
- Local lint/type/unit/integration: not run; no feature implementation exists to validate.
- CI: not run; branch not pushed and no PR created. A report-only PR would not deliver the requested implementation.
- UAT: not run; Stage 00 remains BLOCKED and neither stopped host was started.

Resume by obtaining the agreed Stage 01 specification (or exact document/history/memory reference), recording it with provenance, and implementing only those requirements on this separate branch with synthetic users, isolated databases and fake integrations. Recheck current upstream fixes and CI triggers before any later push. No production or Stage 00 artifact changes were made.
