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
- `DB_PATH`: database file path. Set this only after selecting and testing the Phase 2 service's durable storage location.
- `NODE_ENV=production`.

## Generate keys on Windows PowerShell

Generate a 32-byte encryption key (64 hex characters):

```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
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
3. Configure a durable database location and verify backup/restore.
4. Set the exact Phase 2 frontend origin and success URL.
5. Run the CI checks and a two-customer integration test.
6. Verify that `/config/status` reports `configured: true` and `tokenEncryptionConfigured: true` without exposing any secret values.
7. Test account creation, login/logout, Facebook linking, Pages, immediate publishing, scheduled publishing, and cross-customer access denial with test accounts only.

Do not enable public customer signups until the release checklist passes.
