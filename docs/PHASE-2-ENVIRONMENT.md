# Phase 2 environment configuration

This checklist is for a **new, separate Phase 2 backend service only**. Do not apply these settings to the Phase 1 Stable service.

## Required environment variables

- `META_APP_ID`: existing Meta app ID.
- `META_APP_SECRET`: existing Meta app secret; set in the hosting provider's secret environment UI only.
- `APP_BASE_URL`: the exact HTTPS URL of the new Phase 2 backend service, without a trailing slash.
- `FRONTEND_ORIGIN`: the exact origin of the separate Phase 2 frontend, without a path or trailing slash.
- `FRONTEND_SUCCESS_URL`: the Phase 2 frontend root URL used after Facebook OAuth.
- `SESSION_SECRET`: a newly generated random secret for Phase 2 sessions; do not reuse or reveal it in chat.
- `TOKEN_ENCRYPTION_KEY`: a separate random 32-byte key, represented as 64 hexadecimal characters. Keep it in the hosting provider's secret environment UI and back it up securely outside the repository.

Optional:
- `META_LOGIN_CONFIG_ID`: the Meta Login for Business configuration ID, if used by the app.
- `DB_PATH`: absolute path to the database file on the Phase 2 persistent disk. Production startup requires this value; verify the disk mount is actually persistent.
- `NODE_ENV=production`.

## Generate keys on Windows PowerShell

Generate a 32-byte encryption key (64 hex characters):

```powershell
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
-join ($bytes | ForEach-Object { $_.ToString('x2') })
```

Generate a separate session secret:

```powershell
$bytes = New-Object byte[] 48
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)
```

Copy each generated value directly into the corresponding secret environment setting. Never commit it, paste it into a GitHub file, or send it in a chat message.

## Before enabling customer accounts

1. Create new Phase 2 backend and frontend services from `phase-2/customer-service-system`; do not reuse the Stable service.
2. Configure the correct Meta OAuth callback URL: `APP_BASE_URL/auth/facebook/callback`.
3. Configure a durable database location using a **new, empty Phase 2 database file**; never point Phase 2 at the Stable database or copy its SQLite file. Verify backup/restore.
4. Set the exact Phase 2 frontend origin and success URL.
5. Run the CI checks and a two-customer integration test.
6. Verify that `/config/status` reports `configured: true` and `tokenEncryptionConfigured: true` without exposing any secret values.
7. Test account creation, login/logout, Facebook linking, Pages, immediate publishing, scheduled publishing, and cross-customer access denial with test accounts only.

Do not enable public customer signups until the release checklist passes.


## Free-plan pilot — temporary testing only

The Phase 2 Part 1 registration limit is enforced in backend code at **20 customer accounts**. This cap is not a subscription/billing feature and must not be raised as part of Part 1.

A free Render web service is suitable for controlled integration testing and demos only:
- It may sleep after 15 minutes without inbound traffic, causing a cold-start delay.
- Its local SQLite database and uploaded files can disappear on restart, spin-down, or redeploy.
- Free Render Postgres expires after 30 days and has no managed backups.

Do not use the free service as the sole store for real paying customers' Facebook tokens, scheduled posts, images, or history. Do not claim scheduled publishing is reliable while the service can sleep. No Render resource should be created or upgraded without explicit approval.

## Deferred to Phase 2 Part 2
Unlimited/customer-cap expansion, subscription tiers, payment processing, plan-based scheduling windows, billing status, and plan enforcement are deliberately out of scope until the user approves starting Part 2.


## Prepared free test deployment (not yet created)

A separate, isolated blueprint is available at [`render.phase2-free.yaml`](../render.phase2-free.yaml). It names two **new Phase 2 test services**:
- `facebook-bulk-scheduler-pro-3-p2-api` — free backend
- `facebook-bulk-scheduler-pro-3-p2-web` — free static frontend

This blueprint is not the existing `render.yaml` and must not be applied to either Phase 1 Stable service. It has **not** been deployed yet. Before using it:
1. Confirm the exact service URLs are available in Render.
2. Set the Meta App ID and App Secret only in Render's secret environment fields; never commit them or send them in chat.
3. Set `TOKEN_ENCRYPTION_KEY` to a fresh random 32-byte key (64 hexadecimal characters).
4. Add `https://facebook-bulk-scheduler-pro-3-p2-api.onrender.com/auth/facebook/callback` to the Meta app's valid OAuth redirect URIs after confirming the actual backend URL.
5. Use test Facebook accounts only. The blueprint uses `NODE_ENV=test` and `/tmp/phase2-test.sqlite` deliberately because free service storage is ephemeral; **all account data, sessions, images, and schedules may be lost** on restart, spin-down, or redeploy.
6. Do not use this free deployment as the live service for paying customers or depend on it for guaranteed scheduled publishing.

No Render resources have been created by adding this blueprint. Creating the free services is a separate deployment action.
