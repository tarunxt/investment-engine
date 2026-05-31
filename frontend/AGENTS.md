<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

After frontend changes, follow the root `AGENTS.md` default release behavior.
Use `scripts/release-prod.sh` to commit, push, dispatch production deploys, and monitor rollout when you are on `main` and `gh` is available.
In Codex cloud/browser task environments or task branches, use the PR -> merge-to-`main` -> GitHub Actions deploy path from the root `AGENTS.md` instead.
