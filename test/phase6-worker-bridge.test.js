import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPhase6WorkerBridge, isPhase6WorkerHealthy } from '../phase6-worker-bridge.js';

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    json(value) { this.body = value; return this; }
  };
}
function makeApp() {
  const routes = new Map();
  return { routes, post(path, handler) { routes.set(path, handler); } };
}

test('Phase 6 bridge rejects requests without its private secret', async () => {
  process.env.PHASE6_WORKER_SECRET = 'test-secret';
  process.env.PHASE6_WORKER_MODE = 'external';
  const app = makeApp();
  registerPhase6WorkerBridge(app, { db: {}, getPhase5Access: async () => ({}), decryptToken: value => value, now: () => new Date().toISOString() });
  const response = makeResponse();
  await app.routes.get('/internal/phase6/claim')({ headers: {}, body: {} }, response);
  assert.equal(response.statusCode, 401);
});

test('Phase 6 bridge refuses claims until external mode is enabled', async () => {
  process.env.PHASE6_WORKER_SECRET = 'test-secret';
  process.env.PHASE6_WORKER_MODE = 'disabled';
  const app = makeApp();
  registerPhase6WorkerBridge(app, { db: {}, getPhase5Access: async () => ({}), decryptToken: value => value, now: () => new Date().toISOString() });
  const response = makeResponse();
  await app.routes.get('/internal/phase6/claim')({ headers: { 'x-phase6-worker-secret': 'test-secret' }, body: {} }, response);
  assert.equal(response.statusCode, 409);
});

test('completion refuses to update a job with a stale claim ID', () => {
  process.env.PHASE6_WORKER_SECRET = 'test-secret';
  process.env.PHASE6_WORKER_MODE = 'external';
  const app = makeApp();
  const db = { prepare: () => ({ run: () => ({ changes: 0 }) }) };
  registerPhase6WorkerBridge(app, { db, getPhase5Access: async () => ({}), decryptToken: value => value, now: () => new Date().toISOString() });
  const response = makeResponse();
  app.routes.get('/internal/phase6/complete')({
    headers: { 'x-phase6-worker-secret': 'test-secret' },
    body: { jobId: 'job-1', claimId: 'stale-claim', outcome: 'published', postId: 'fb-post-1' }
  }, response);
  assert.equal(response.statusCode, 409);
});

test('Phase 3 fallback is inactive until Phase 6 sends a heartbeat', () => {
  assert.equal(isPhase6WorkerHealthy(), false);
});
