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
