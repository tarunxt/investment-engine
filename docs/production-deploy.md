# Production deploy runbook

This repo deploys production through GitHub Actions over SSH. Codex should change code in GitHub; GitHub Actions then syncs `main` to the EC2 checkout and restarts the production services.

## Production target

- Domain: `https://cred-x.in`
- EC2 app root: `/srv/investor`
- App user: `investor`
- Backend: FastAPI on `127.0.0.1:8000`
- Frontend: Next.js on `127.0.0.1:3000`
- Services restarted by deploy:
  - `investor-backend`
  - `investor-celery-worker`
  - `investor-celery-beat`
  - `investor-frontend` for full-stack deploys

## Required GitHub repository secrets

Set these under GitHub repo settings → Secrets and variables → Actions → Repository secrets:

- `EC2_HOST`: production EC2 public IP or hostname
- `EC2_USER`: SSH user, normally `ubuntu`
- `EC2_SSH_KEY`: private SSH key with access to the EC2 host

Do not commit the SSH key to the repo.

## Optional GitHub repository variables

The deploy workflow now defaults to the current production layout, so `APP_PATH` is not required.

Set these only if the server layout changes:

- `EC2_APP_PATH`: defaults to `/srv/investor`
- `EC2_APP_USER`: defaults to `investor`

## How deploy works

The workflow `.github/workflows/deploy.yml` runs on every push to `main` and can also be run manually.

On EC2 it does the following:

1. Verifies the app checkout exists.
2. Syncs the server repo to `origin/main` using the app user.
3. Runs `deploy/no-docker/redeploy.sh`.
4. Restarts the relevant systemd services.
5. Runs local smoke checks:
   - `http://127.0.0.1:8000/health/live`
   - `http://127.0.0.1:8000/health/ready`
   - `http://127.0.0.1:3000/login` for full-stack deploys

## Manual deploy

From GitHub Actions, run **Deploy to Production** manually:

- `backend`: backend-only deploy
- `full`: backend + frontend deploy
- `auto`: full deploy when run manually

## Important rule

Do not manually edit production files on EC2 as the normal path. Those edits can be overwritten by the next deploy. Make the change in GitHub, merge/push to `main`, and let the deploy workflow update EC2.
