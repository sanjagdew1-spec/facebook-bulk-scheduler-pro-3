# Phase 2 — Customer Service System

Status: IN PROGRESS  
Base: `stable/working-app-2026-10-16`  
Working branch: `phase-2/customer-service-system`

## Safety rule

- Do not modify the Phase 1 stable branches or their Render services as part of Phase 2.
- All Phase 2 changes stay on this branch and are tested separately.
- Do not deploy customer-facing changes until the security and acceptance checklist below passes.
- Never commit Meta app secrets, access tokens, session secrets, customer credentials, or production database files.

## Goal

Turn the working single-owner Facebook Page scheduler into a service that can safely support multiple independent customers.

## Milestones

1. **Architecture and tenant isolation**
   - Define customer accounts and stable internal customer IDs.
   - Link each Facebook authorization to the correct customer account.
   - Ensure Pages, scheduled jobs, history, images, and tokens are scoped to the authenticated customer.
   - Add authorization checks to every customer-specific API endpoint.

2. **Customer sign-in and sessions**
   - Add a customer login/session flow distinct from Facebook OAuth.
   - Use secure, HTTP-only cookies, CSRF protections for state-changing actions, session expiry, and logout.
   - Do not expose tokens or secrets to the browser.

3. **Customer workspace**
   - Add a customer dashboard for connection status, their own Pages, scheduled posts, and history.
   - Make disconnected/expired Facebook authorization understandable and recoverable.

4. **Data storage and migration**
   - Review persistence before multi-customer production use. Current SQLite/local-file assumptions must not be treated as production-safe shared hosting without checking Render disk/database persistence and backup behavior.
   - Add migrations and a tested backup/restore process before storing real customer data.

5. **Testing and release gate**
   - Test that Customer A cannot view or change Customer B's Pages, jobs, images, history, or connection details.
   - Test invalid/expired sessions, logout, OAuth state validation, and failure recovery.
   - Test publish-now and scheduled publishing using isolated test accounts.
   - Deploy only to a separate Phase 2 service after tests pass and configuration is reviewed.

## Acceptance criteria

- Every customer-specific request requires an authenticated customer identity.
- Every database read/write is scoped to that customer and is checked server-side.
- Facebook OAuth callback is securely linked to the initiating customer session.
- Secrets and page access tokens never appear in client responses or logs.
- Phase 1 stable app and backend remain unchanged.
- Phase 2 has its own environment variables, service, and test accounts.

## Current technical observations

- The Phase 1 backend currently has `pages` and `jobs` tables with a `user_id` field, but the existing Facebook user identity must be reviewed before using it as a customer-account boundary.
- The current backend uses SQLite and express-session. Before multi-customer service launch, verify durable storage and backups for the chosen hosting configuration.
- The current Facebook OAuth flow must be reviewed for session binding and account linking before adding customer sign-in.
- Meta permissions, app review, platform terms, and publishing eligibility remain external dependencies; they cannot be guaranteed by application code alone.

## Next implementation step

Audit every backend route and its authorization requirements, then create the customer-account data model and tenant-isolation tests before building the customer-facing dashboard.


## Backend route audit (2026-10-17)

This audit is based on the current `server.js` on the Phase 2 branch. It is an implementation checklist, not a claim that multi-customer security is already complete.

| Route / area | Current gate | Phase 2 requirement |
| --- | --- | --- |
| `GET /health` | Public | Keep minimal; do not expose secrets or customer data |
| `GET /config/status` | Public; exposes only presence/length flags and callback URL | Keep secret values hidden; consider restricting operational diagnostics |
| `GET /auth/facebook` | Session + OAuth state | Must require a signed-in customer before linking a Facebook account; bind OAuth state to customer ID and session |
| `GET /auth/facebook/callback` | Checks OAuth state in session | Verify state, initiating customer, and one-time use; never silently switch the customer's identity |
| `GET /auth/status`, `POST /auth/logout` | Facebook session | Replace/extend with customer-session status and safe logout semantics |
| `GET /api/pages` | Facebook session; records keyed by Facebook user ID | Resolve authenticated internal customer ID; store/list only pages linked to that customer |
| `GET /api/jobs` | Facebook session; query filtered by Facebook user ID | Filter by internal customer ID; ensure all history/images are similarly scoped |
| `POST /api/schedule` | Facebook session; selected pages checked for same Facebook user | Resolve Page ownership through customer mapping; reject any cross-customer Page/job reference |
| `POST /api/publish-now` | Facebook session; selected pages checked for same Facebook user | Same customer ownership checks, rate limits, request-size limits, and safe error handling |
| `DELETE /api/schedule/:id` | Query includes job ID and Facebook user ID | Query must use internal customer ID and preserve status guard |
| Cron publishing worker | Uses each job's user_id to find the page token | Worker must enforce a matching customer/page relationship and never accept customer identity from job payloads |
| SQLite tables / session store | One local SQLite file by default | Decide durable storage/backup strategy before production; use migrations and verify foreign keys |

## Security findings to resolve before customer rollout

1. **No separate customer identity yet.** Current `requireAuth` only checks `req.session.fbUser`; that is suitable for the existing single-owner flow but is not a customer email/password or customer-account login.
2. **OAuth is currently the login identity.** Phase 2 needs customer authentication first, then a deliberate “Connect Facebook” linking flow. OAuth state alone must not be treated as proof that a Facebook account belongs to a specific customer account.
3. **Token storage.** Page access tokens are stored in SQLite. Before production, decide on encryption at rest/key management, access restrictions, token refresh/revocation handling, and log redaction.
4. **Request protection.** State-changing endpoints currently rely on session cookies and CORS. CORS is not CSRF protection. Add CSRF/origin validation and rate limiting for customer-authenticated state-changing requests.
5. **Input and resource limits.** JSON request body is configured at 50 MB while accepted photo payload limits are lower. Add explicit request rate/size controls and consistent validation as part of the Phase 2 service.
6. **Operational persistence.** `DB_PATH` defaults to a local file. Production deployment must verify persistent storage, backup/restore, and migration behavior before real customer data is accepted.
7. **Scheduler isolation.** Scheduled jobs must reference an internally validated customer and Page relationship; tenant checks must be enforced at creation and again when processing jobs.

## Safe implementation order

1. Add a small automated test harness for tenant-ownership rules and route guards.
2. Add internal customer account and Facebook connection mapping tables using migrations that are safe on a fresh database and an existing copy.
3. Introduce customer authentication on the Phase 2 branch only; do not alter the stable service's login flow.
4. Refactor customer-facing API queries to use internal customer IDs and prove cross-customer requests fail closed.
5. Add isolated test configuration and run tests before creating/deploying a Phase 2 Render service.

**Release gate:** Do not point the existing stable frontend at Phase 2 and do not deploy Phase 2 over any stable service. This branch is not yet production-ready for multiple customers.
