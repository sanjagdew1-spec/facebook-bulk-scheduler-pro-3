# Cloudflare Standalone Port — Working Plan

## Isolation rule
This work is on branch `cloudflare/standalone-port-2026-11-09`. Do not modify Render's configured branches or deploy from this branch to any Render service. Existing Render code and services remain untouched.

## Source baseline
- Scheduler + Phase 6 worker source: `phase-6/parallel-page-workers` at `e595b2e83f9bbb6488aa65e0666aaace5a94c80b`.
- Owner/Admin panel source reference: `phase-5/owner-admin-panel` at `379f5cb3ab37f7e97e191c9c61e81b1e4042343d`.
- Phase 3 known-good behavior reference: `phase-3/ui-workflow` at `fc577584fd70aa280d9dbf2f9127296e6fb01e7a`.

## Required parity
Preserve customer registration/login (no OTP requirement), Facebook Page connection and permissions, bulk photo workflow, per-photo captions/AI labels, scheduling, history, dashboard, advanced mode, owner/admin controls, plan entitlements, and worker publishing behavior.

## Cloudflare target
- Pages for static frontend(s).
- Workers for API endpoints and scheduled/queue orchestration.
- D1 for relational metadata and scheduler state.
- R2 for temporary photo objects, with expiry/lifecycle cleanup and deletion after successful publish.
- Durable Objects or a D1-backed lease/idempotency mechanism for single-active-worker ownership and safe failover.

## Safety constraints
- Never deploy this branch to the existing Render services.
- Never allow Render and Cloudflare workers to publish the same scheduled job concurrently.
- Do not copy secrets, OAuth tokens, customer records, or uploaded photo bytes into Git.
- Live Render database and uploaded media are not included in this source-code branch; their export requires live service/database access and must be handled separately.
- Do not claim feature parity or production readiness until automated tests and real Facebook integration tests pass.

## Current status
This branch is an isolated source-code working branch inside the existing repository, not yet a separate GitHub repository. The GitHub connector available to this session can create branches and files but does not expose repository-creation/fork actions. Create a separate repository and transfer this branch when an authorized repository-creation path is available.
