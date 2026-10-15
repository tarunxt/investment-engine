# Google sign-in

The login page uses Google's official Identity Services button. Its ID token is
submitted through Auth.js's CSRF-protected `google` credentials provider to the
backend, which verifies Google's signature, audience, issuer, expiry, subject,
and verified email before issuing the existing application session tokens.
Application access/refresh tokens remain in the server-side Auth.js session flow.

Only existing, active Cred-X accounts can sign in. Roles and user IDs are preserved;
Google sign-in never creates accounts or enables inactive accounts. Ambiguous
case-insensitive email matches fail closed. Automatic email matching is limited
to Gmail and Google Workspace identities where Google is authoritative. Other
Google accounts must use their existing password. Password sign-in remains available.

## Configuration

The public OAuth web client ID is resolved in this order:

1. `GOOGLE_SIGNIN_CLIENT_ID` in `/etc/investor/backend.env`.
2. The owner-approved public client ID in `google_signin.py`:
   `833980592098-0vt4iu94cqokkv1nmp6oqh6evdgmg5sj.apps.googleusercontent.com`.

Sign-in does not inherit Google Sheets or generic Google integration credentials.

No client secret is read, decrypted, copied, or sent to the browser for sign-in.
The `/auth/google/config` endpoint exposes only the public ID and an enabled flag.
If no ID is configured, the login page explains that password sign-in is available.

In Google Cloud's OAuth web client settings, authorize the JavaScript origin
`https://cred-x.in` (and any other actual frontend origin in use). For local testing,
authorize `http://localhost:3000`. This uses the GIS popup/callback flow, not an
OAuth redirect flow; the Google Sheets redirect URI remains unchanged. A configured
ID alone does not prove that Google has authorized the frontend origin.

After deployment, verify the button loads, complete a Google login for an existing
active account, and verify its original account/role and authenticated API access.
Also verify password login. Do not report end-to-end success without completing
the Google flow. No trading, queue, worker, or recovery execution gates are changed.
