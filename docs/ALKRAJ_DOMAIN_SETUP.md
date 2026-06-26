# Alkraj production domain setup

The browser screenshot showing the Zoho welcome page for `https://www.alkraj.com` means the domain is still pointed at Zoho DNS/hosting instead of this application server. The application cannot become visible on `alkraj.com` until DNS points to the production host and nginx is configured for the domain.

## Target hostnames

| Hostname | Purpose | Expected destination |
| --- | --- | --- |
| `alkraj.com` | Main Next.js frontend | Production server public IP |
| `www.alkraj.com` | Browser-friendly alias | Production server public IP, then nginx redirects to `alkraj.com` |
| `api.alkraj.com` | FastAPI backend | Production server public IP |

## DNS records to set at the domain registrar / DNS provider

Replace `<PRODUCTION_SERVER_PUBLIC_IP>` with the EC2/VPS public IPv4 address that runs nginx and the app services.

```text
A     @      <PRODUCTION_SERVER_PUBLIC_IP>
A     www    <PRODUCTION_SERVER_PUBLIC_IP>
A     api    <PRODUCTION_SERVER_PUBLIC_IP>
```

Remove any Zoho Sites records for website hosting, especially a `www` CNAME to Zoho or any parked-page A record. Keep Zoho MX/SPF/DKIM records only if Zoho Mail is still used for email.

## Production environment values

For the no-Docker production deployment, set these values in `/etc/investment-engine/frontend.env`:

```bash
NODE_ENV=production
NEXT_PUBLIC_API_URL=https://api.alkraj.com
NEXT_PUBLIC_FRONTEND_URL=https://alkraj.com
NEXTAUTH_URL=https://alkraj.com
NEXTAUTH_SECRET=<generate-strong-secret>
AUTH_TRUST_HOST=true
```

Set these domain values in `/etc/investment-engine/backend.env`:

```bash
FRONTEND_URL=https://alkraj.com
GOOGLE_REDIRECT_URI=https://alkraj.com/console/google-sheets/callback
SMTP_FROM_EMAIL=noreply@alkraj.com
```

Keep all database passwords, JWT secrets, OAuth secrets, provider API keys, and encryption keys in the server env files only. Do not commit them.

## nginx setup

This repository includes two nginx configs for Alkraj: `deploy/no-docker/nginx/alkraj.bootstrap.conf` for first-time certificate issuance and `deploy/no-docker/nginx/alkraj.conf` for the final HTTPS reverse proxy.

On the production server, install the bootstrap HTTP-only config first so Let's Encrypt can validate the hostnames before any certificate files exist:

```bash
sudo mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled /var/www/letsencrypt
sudo cp /srv/investment-engine/deploy/no-docker/nginx/alkraj.bootstrap.conf /etc/nginx/sites-available/alkraj.conf
sudo ln -sfn /etc/nginx/sites-available/alkraj.conf /etc/nginx/sites-enabled/alkraj.conf
sudo nginx -t
sudo systemctl reload nginx
```

Issue certificates after DNS points to the server:

```bash
sudo certbot certonly --webroot -w /var/www/letsencrypt -d alkraj.com -d www.alkraj.com
sudo certbot certonly --webroot -w /var/www/letsencrypt -d api.alkraj.com
```

Then switch nginx to the final HTTPS reverse-proxy config:

```bash
sudo cp /srv/investment-engine/deploy/no-docker/nginx/alkraj.conf /etc/nginx/sites-available/alkraj.conf
sudo nginx -t
sudo systemctl reload nginx
```

## Deploy and verify

After DNS, env files, certificates, and nginx are ready, deploy the full stack:

```bash
cd /srv/investment-engine
SKIP_GIT_SYNC=false bash deploy/no-docker/redeploy.sh full
```

Verify locally on the server first:

```bash
curl -I http://127.0.0.1:3000
curl -I http://127.0.0.1:8000/health
sudo systemctl status investment-engine-frontend investment-engine-backend --no-pager
```

Verify the public domain after DNS propagation:

```bash
curl -I https://alkraj.com
curl -I https://www.alkraj.com
curl -I https://api.alkraj.com/health
```

Expected results:

- `https://alkraj.com` returns the Next.js app.
- `https://www.alkraj.com` returns a `301` redirect to `https://alkraj.com`.
- `https://api.alkraj.com/health` returns the FastAPI health response.

## Troubleshooting checklist

1. If `www.alkraj.com` still shows Zoho, DNS for `www` still points to Zoho or browser/ISP DNS cache has not expired.
2. If `alkraj.com` works but `www.alkraj.com` does not, confirm the `www` A record and the certificate covering `www.alkraj.com`.
3. If the frontend loads but API calls fail, confirm `NEXT_PUBLIC_API_URL=https://api.alkraj.com`, `api.alkraj.com` DNS, and the backend service health.
4. If Google OAuth fails, update the Google Cloud OAuth redirect URI to `https://alkraj.com/console/google-sheets/callback` and match `/etc/investment-engine/backend.env`.
5. If nginx fails to reload, run `sudo nginx -t` and fix the exact certificate or config path reported.
