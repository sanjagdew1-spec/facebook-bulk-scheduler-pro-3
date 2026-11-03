import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
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

test('Phase 6 claim reads the existing Phase 3 SQLite records and completes the same job', async () => {
  process.env.PHASE6_WORKER_SECRET = 'test-secret';
  process.env.PHASE6_WORKER_MODE = 'external';
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE customer_accounts (id TEXT PRIMARY KEY,status TEXT,email_normalized TEXT);
    CREATE TABLE customer_facebook_connections (id TEXT,customer_id TEXT,facebook_user_id TEXT);
    CREATE TABLE customer_pages (customer_id TEXT,facebook_user_id TEXT,page_id TEXT,access_token TEXT);
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,user_id TEXT,page_id TEXT,page_name TEXT,message TEXT,image_url TEXT,
      image_data BLOB,image_mime_type TEXT,scheduled_at TEXT,status TEXT,post_id TEXT,error TEXT,
      created_at TEXT,updated_at TEXT,customer_id TEXT,retry_count INTEGER DEFAULT 0,
      is_ai_content INTEGER DEFAULT 0,worker_claim_id TEXT,worker_claimed_at TEXT
    );
    CREATE TABLE job_images (job_id TEXT,position INTEGER,image_data BLOB,image_mime_type TEXT);
  `);
  const timestamp = new Date().toISOString();
  db.prepare('INSERT INTO customer_accounts(id,status,email_normalized) VALUES(?,?,?)').run('customer-1','active','test@example.com');
  db.prepare('INSERT INTO customer_pages(customer_id,facebook_user_id,page_id,access_token) VALUES(?,?,?,?)')
    .run('customer-1','facebook-user-1','page-1','encrypted-page-token');
  db.prepare("INSERT INTO jobs(id,user_id,page_id,page_name,message,image_url,image_data,image_mime_type,scheduled_at,status,created_at,updated_at,customer_id,retry_count,is_ai_content) VALUES(?,?,?,?,?,?,?,?,?,'scheduled',?,?,?,0,1)")
    .run('job-1','facebook-user-1','page-1','Page One','Hello','','photo-bytes','image/jpeg',new Date(Date.now()+10000).toISOString(),timestamp,timestamp,'customer-1');

  const app = makeApp();
  registerPhase6WorkerBridge(app, {
    db,
    getPhase5Access: async () => ({ allowed: true, unlimited: true, role: 'developer' }),
    decryptToken: value => value === 'encrypted-page-token' ? 'plain-page-token' : '',
    now: () => new Date().toISOString()
  });

  const claimResponse = makeResponse();
  await app.routes.get('/internal/phase6/claim')({
    headers: { 'x-phase6-worker-secret': 'test-secret' },
    body: { limit: 10 }
  }, claimResponse);

  assert.equal(claimResponse.statusCode, 200);
  assert.equal(claimResponse.body.claimedCount, 1);
  const claimedJob = claimResponse.body.jobs[0];
  assert.equal(claimedJob.id, 'job-1');
  assert.ok(Date.parse(claimedJob.scheduled_at) > Date.now(), 'the worker should receive this post before its target time');
  assert.equal(claimedJob.pageAccessToken, 'plain-page-token');
  assert.equal(claimedJob.photos[0].dataBase64, Buffer.from('photo-bytes').toString('base64'));
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get('job-1').status, 'publishing');

  const completeResponse = makeResponse();
  app.routes.get('/internal/phase6/complete')({
    headers: { 'x-phase6-worker-secret': 'test-secret' },
    body: { jobId: 'job-1', claimId: claimedJob.claimId, outcome: 'published', postId: 'facebook-post-1' }
  }, completeResponse);
  assert.equal(completeResponse.statusCode, 200);
  const finalJob = db.prepare('SELECT status,post_id,worker_claim_id FROM jobs WHERE id=?').get('job-1');
  assert.equal(finalJob.status, 'published');
  assert.equal(finalJob.post_id, 'facebook-post-1');
  assert.equal(finalJob.worker_claim_id, null);
  db.close();
});

test('Phase 6 heartbeat activates the Phase 3 local-scheduler fallback guard', () => {
  process.env.PHASE6_WORKER_SECRET = 'test-secret';
  process.env.PHASE6_WORKER_MODE = 'external';
  const app = makeApp();
  registerPhase6WorkerBridge(app, { db: {}, getPhase5Access: async () => ({}), decryptToken: value => value, now: () => new Date().toISOString() });
  const response = makeResponse();
  app.routes.get('/internal/phase6/heartbeat')({
    headers: { 'x-phase6-worker-secret': 'test-secret' },
    body: {}
  }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(isPhase6WorkerHealthy(), true);
});
