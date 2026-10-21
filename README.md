# Facebook Bulk Scheduler Pro 3

Separate starter project for the third Meta app. This repository is intentionally separate from `facebook-bulk-scheduler`.

## Current status
- Static GitHub Pages frontend
- Express backend with Facebook OAuth / Login for Business configuration support
- Page listing, scheduled photo-post jobs, and SQLite-backed job history
- Real posting and scheduled publishing must be tested with the new Meta App before production use

## Deploy the frontend
Enable GitHub Pages for the `main` branch, root folder. The expected URL is:
`https://sanjagdew1-spec.github.io/facebook-bulk-scheduler-pro-3/`

## Deploy the backend on Render
Create a new Web Service from this repository. Use Docker runtime (the repository includes a Dockerfile). After deployment, set these environment variables in Render:
- `META_APP_ID`: new Meta App ID
- `META_APP_SECRET`: new Meta App Secret (Render only; never put it in GitHub)
- `META_LOGIN_CONFIG_ID`: Facebook Login for Business Configuration ID
- `APP_BASE_URL`: actual new Render service URL, with no trailing slash
- `FRONTEND_ORIGIN`: `https://sanjagdew1-spec.github.io`
- `FRONTEND_SUCCESS_URL`: `https://sanjagdew1-spec.github.io/facebook-bulk-scheduler-pro-3/`
- `SESSION_SECRET`: a long random secret

Then add the exact callback URL `https://YOUR-RENDER-SERVICE.onrender.com/auth/facebook/callback` to Meta's Valid OAuth Redirect URIs. Replace the example host with the actual Render service hostname.

## Important
The UI currently schedules images by public HTTPS image URL; local image upload and multi-photo albums are not implemented in this starter. Verify Meta permission access and Page publishing before using it with real Pages. Use a persistent Render disk for SQLite if scheduled jobs must survive service restarts/redeploys. Never share or commit tokens, app secrets, or passwords.


## Phase 4 — Owner/Admin Control Panel
Phase 4 is isolated on branch `phase-4/owner-admin-control-panel`. The customer-facing Phase 3 deployment is not changed by this branch.

- Private admin interface: `/owner-admin` on the Phase 4 API service.
- Plans: Free Demo, Starter/Standard, Pro, Business; configure duration and optional Page, monthly-post, and batch-slot limits.
- Customers: filter by plan, inspect account ID/email verification status, dates, remaining days, connected Page usage and monthly jobs, then assign/renew a plan.
- Creators: save a sponsorship and activate Live for an existing customer account, with the selected plan duration and limits.
- Developer: grant/revoke unlimited app entitlement for a customer ID or email.
- Admin audit log: records plan, creator and developer entitlement changes.
- The owner/admin allowlist is enforced server-side using `OWNER_ADMIN_EMAILS` and/or `OWNER_ADMIN_IDS`. Owner unlimited entitlement uses `OWNER_USER_EMAILS` and/or `OWNER_USER_IDS`. Use the exact customer-account email or ID; never expose these values in public frontend code.
- `/api/customer/entitlement` reports owner/developer unlimited access or a customer's configured plan and usage.

Before using the panel, set the allowlist environment variables on the Phase 4 API service and configure persistent storage for its SQLite database. The customer email field currently reports verification state from `email_verified_at`; existing accounts remain pending until an email-verification workflow is implemented. Plan limits are stored/displayed by Phase 4; enforcing those limits across every publishing route and the customer UI is a subsequent integration step, not claimed complete here.
