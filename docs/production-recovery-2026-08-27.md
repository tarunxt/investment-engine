# Production backend recovery — 27 August 2026

A recovery-safe full-stack deployment was triggered after the public FastAPI readiness endpoint returned nginx `502 Bad Gateway`, while the Next.js frontend remained available. The deployment reinstalls the backend runtime, reapplies the systemd service templates, restarts the API and worker services, and runs the deployment health checks.
