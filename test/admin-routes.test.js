import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3';
import { registerOwnerAdminRoutes } from '../admin-routes.js';

test('Phase 4 Owner/Admin API enforces allowlist and manages plans, creators, and developer entitlements', async t => {
  const previous = {
    OWNER_ADMIN_EMAILS: process.env.OWNER_ADMIN_EMAILS,
    OWNER_ADMIN_IDS: process.env.OWNER_ADMIN_IDS,
    OWNER_USER_EMAILS: process.env.OWNER_USER_EMAILS,
    OWNER_USER_IDS: process.env.OWNER_USER_IDS,
    APP_BASE_URL: process.env.APP_BASE_URL
  };
  process.env.OWNER_ADMIN_EMAILS = 'owner@example.com';
  process.env.OWNER_ADMIN_IDS = '';
  process.env.OWNER_USER_EMAILS = 'owner@example.com';
  process.env.OWNER_USER_IDS = '';
  process.env.APP_BASE_URL = 'http://127.0.0.1';
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE customer_accounts (
      id TEXT PRIMARY KEY, email_normalized TEXT NOT NULL UNIQUE, username TEXT UNIQUE,
      password_hash TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE customer_pages (customer_id TEXT NOT NULL, page_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '');
    CREATE TABLE jobs (id TEXT PRIMARY KEY, customer_id TEXT, created_at TEXT NOT NULL);
    INSERT INTO customer_accounts(id,email_normalized,username,status,created_at,updated_at)
      VALUES ('owner-id','owner@example.com','owner','active','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z');
    INSERT INTO customer_accounts(id,email_normalized,username,status,created_at,updated_at)
      VALUES ('customer-id','customer@example.com','customer','active','2026-10-02T00:00:00Z','2026-10-02T00:00:00Z');
    INSERT INTO customer_pages(customer_id,page_id,name) VALUES ('customer-id','page-1','Demo Page');
    INSERT INTO jobs(id,customer_id,created_at) VALUES ('job-1','customer-id',strftime('%Y-%m-%dT%H:%M:%SZ','now'));
  `);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const id = req.headers['x-test-user'] || '';
    const row = db.prepare('SELECT id,email_normalized AS email,username FROM customer_accounts WHERE id=?').get(id);
    req.session = row ? { customerAccount: { id: row.id, email: row.email, username: row.username } } : {};
    next();
  });
  registerOwnerAdminRoutes(app, { db, trustedOrigins: new Set(['http://127.0.0.1']) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = (path, { user = 'owner-id', method = 'GET', body } = {}) => fetch(base + path, {
    method, headers: { 'x-test-user': user, 'content-type': 'application/json', origin: 'http://127.0.0.1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  const denied = await call('/api/admin/overview', { user: 'customer-id' });
  assert.equal(denied.status, 403);
  const overviewResponse = await call('/api/admin/overview');
  assert.equal(overviewResponse.status, 200);
  const overview = await overviewResponse.json();
  assert.equal(overview.owner.unlimited, true);
  assert.equal(overview.plans.find(p => p.key === 'free_demo').duration_days, 7);
  assert.equal(overview.plans.find(p => p.key === 'pro').daily_post_limit, 100);

  const assignmentResponse = await call('/api/admin/customers/customer-id/plan', {
    method: 'POST', body: { planKey: 'pro', durationDays: 30 }
  });
  assert.equal(assignmentResponse.status, 200);
  const customerEntitlement = await (await call('/api/customer/entitlement', { user: 'customer-id' })).json();
  assert.equal(customerEntitlement.planKey, 'pro');
  assert.equal(customerEntitlement.limits.postsPerDay, 100);
  assert.equal(customerEntitlement.usage.pages, 1);

  const creatorResponse = await call('/api/admin/creators', {
    method: 'POST', body: { email: 'customer@example.com', name: 'Creator', planKey: 'starter', durationDays: 30 }
  });
  assert.equal(creatorResponse.status, 201);
  const creatorList = await (await call('/api/admin/creators')).json();
  const creatorId = creatorList.creators[0].id;
  const liveResponse = await call('/api/admin/creators/' + creatorId + '/live', { method: 'POST', body: {} });
  assert.equal(liveResponse.status, 200);
  const creatorEntitlement = await (await call('/api/customer/entitlement', { user: 'customer-id' })).json();
  assert.equal(creatorEntitlement.planKey, 'starter');

  const developerResponse = await call('/api/admin/developers', {
    method: 'POST', body: { subjectType: 'customer_id', subjectId: 'customer-id', label: 'QA developer' }
  });
  assert.equal(developerResponse.status, 201);
  const developerEntitlement = await (await call('/api/customer/entitlement', { user: 'customer-id' })).json();
  assert.equal(developerEntitlement.unlimited, true);
  assert.equal(developerEntitlement.role, 'developer');
});
