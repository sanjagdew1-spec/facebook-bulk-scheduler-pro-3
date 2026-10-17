import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', err => err ? reject(err) : resolve()));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  return port;
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Phase 2 backend exited before health check.');
    try {
      const response = await fetch(baseUrl + '/health');
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Phase 2 backend did not become healthy in time.');
}

test('HTTP customer registration, session status, login, and logout work on an isolated SQLite DB', { timeout: 30000 }, async t => {
  const port = await freePort();
  const directory = await import('node:fs/promises').then(fs => fs.mkdtemp(path.join(os.tmpdir(), 'phase2-http-')));
  const dbPath = path.join(directory, 'test.sqlite');
  const baseUrl = 'http://127.0.0.1:' + port;
  const origin = 'http://phase2-frontend.test';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      APP_BASE_URL: 'https://phase2-backend.test',
      FRONTEND_ORIGIN: origin,
      FRONTEND_SUCCESS_URL: origin + '/',
      META_APP_ID: 'test-app-id',
      META_APP_SECRET: 'test-app-secret',
      SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
      TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
      NODE_ENV: 'test'
    }
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 1500);
    });
    await rm(directory, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);
  const configResponse = await fetch(baseUrl + '/config/status');
  assert.equal(configResponse.status, 200);
  const configBody = await configResponse.text();
  assert.ok(configBody.includes('"appSecretPresent":true'));
  assert.ok(configBody.includes('"tokenEncryptionConfigured":true'));
  assert.ok(!configBody.includes('test-app-secret'), 'configuration diagnostics must never expose the Meta app secret');
  assert.ok(!configBody.includes(process.env.TOKEN_ENCRYPTION_KEY || 'no-test-key'), 'configuration diagnostics must never expose the token encryption key');
  const headers = { 'content-type': 'application/json', origin, 'x-forwarded-proto': 'https' };
  const untrustedRegistration = await fetch(baseUrl + '/api/customer/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://attacker.example', 'x-forwarded-proto': 'https' },
    body: JSON.stringify({ email: 'attacker@example.com', password: 'a-long-enough-integration-password' })
  });
  assert.equal(untrustedRegistration.status, 403, 'registration must reject untrusted browser origins');
  const registerResponse = await fetch(baseUrl + '/api/customer/register', {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: 'BrowserTest@Example.com', password: 'a-long-enough-integration-password' })
  });
  assert.equal(registerResponse.status, 201);
  const registered = await registerResponse.json();
  assert.equal(registered.customer.email, 'browsertest@example.com');

  // Fill the pilot to 20 accounts directly, then verify the public registration route blocks account 21.
  const seedDb = new Database(dbPath);
  const seedCustomer = seedDb.prepare('INSERT INTO customer_accounts(id,email_normalized,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?)');
  for (let i = 1; i <= 19; i++) {
    const stamp = new Date().toISOString();
    seedCustomer.run('seed-customer-' + i, 'seed-customer-' + i + '@example.com', 'not-used-in-this-test', 'active', stamp, stamp);
  }
  assert.equal(seedDb.prepare('SELECT COUNT(*) AS count FROM customer_accounts').get().count, 20);
  seedDb.close();

  const overflowResponse = await fetch(baseUrl + '/api/customer/register', {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: 'twentyfirst@example.com', password: 'a-long-enough-integration-password' })
  });
  assert.equal(overflowResponse.status, 409);
  assert.match((await overflowResponse.json()).error, /20-customer pilot is currently full/);
  const firstCookie = registerResponse.headers.get('set-cookie')?.split(';')[0];
  assert.ok(firstCookie, 'registration should set the secure session cookie');

  const statusResponse = await fetch(baseUrl + '/api/customer/status', {
    headers: { origin, 'x-forwarded-proto': 'https', cookie: firstCookie }
  });
  assert.equal(statusResponse.status, 200);
  assert.deepEqual(await statusResponse.json(), {
    signedIn: true,
    customer: { id: registered.customer.id, email: 'browsertest@example.com' }
  });

  const pagesResponse = await fetch(baseUrl + '/api/pages', {
    headers: { origin, 'x-forwarded-proto': 'https', cookie: firstCookie }
  });
  assert.equal(pagesResponse.status, 401, 'customer login alone must not bypass Facebook connection');

  const mutationWithoutOrigin = await fetch(baseUrl + '/api/publish-now', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
    body: JSON.stringify({ pageIds: [] })
  });
  assert.equal(mutationWithoutOrigin.status, 403, 'publishing mutations must reject requests without a trusted Origin');

  const logoutResponse = await fetch(baseUrl + '/api/customer/logout', {
    method: 'POST',
    headers: { ...headers, cookie: firstCookie },
    body: '{}'
  });
  assert.equal(logoutResponse.status, 200);
  assert.equal((await logoutResponse.json()).ok, true);

  const loginResponse = await fetch(baseUrl + '/api/customer/login', {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: 'browsertest@example.com', password: 'a-long-enough-integration-password' })
  });
  assert.equal(loginResponse.status, 200);
  assert.equal((await loginResponse.json()).customer.id, registered.customer.id);
  assert.ok(loginResponse.headers.get('set-cookie'), 'login should issue a fresh secure session cookie');
});


test('backend safely adds Phase 2 columns and tables to an existing Phase 1-style SQLite schema', { timeout: 30000 }, async t => {
  const port = await freePort();
  const directory = await import('node:fs/promises').then(fs => fs.mkdtemp(path.join(os.tmpdir(), 'phase2-migration-')));
  const dbPath = path.join(directory, 'legacy.sqlite');
  const legacyDb = new Database(dbPath);
  legacyDb.exec(`
    CREATE TABLE pages (
      user_id TEXT NOT NULL, page_id TEXT NOT NULL, name TEXT NOT NULL,
      access_token TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id, page_id)
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, page_id TEXT NOT NULL,
      page_name TEXT NOT NULL, message TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '', scheduled_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled', post_id TEXT, error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE job_images (
      job_id TEXT NOT NULL, position INTEGER NOT NULL,
      image_data BLOB NOT NULL, image_mime_type TEXT NOT NULL,
      PRIMARY KEY(job_id, position)
    );
  `);
  legacyDb.close();

  const baseUrl = 'http://127.0.0.1:' + port;
  const origin = 'http://phase2-frontend.test';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      APP_BASE_URL: 'https://phase2-backend.test',
      FRONTEND_ORIGIN: origin,
      FRONTEND_SUCCESS_URL: origin + '/',
      META_APP_ID: 'test-app-id',
      META_APP_SECRET: 'test-app-secret',
      SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
      TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
      NODE_ENV: 'test'
    }
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 1500);
    });
    await rm(directory, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child);
  const migratedDb = new Database(dbPath);
  const pageColumns = migratedDb.prepare('PRAGMA table_info(pages)').all().map(column => column.name);
  const jobColumns = migratedDb.prepare('PRAGMA table_info(jobs)').all().map(column => column.name);
  const accountTable = migratedDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='customer_accounts'").get();
  const customerPagesTable = migratedDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='customer_pages'").get();
  assert.ok(pageColumns.includes('customer_id'));
  assert.ok(jobColumns.includes('customer_id'));
  assert.ok(jobColumns.includes('image_data'));
  assert.ok(jobColumns.includes('image_mime_type'));
  assert.ok(jobColumns.includes('is_ai_content'));
  assert.ok(accountTable);
  assert.ok(customerPagesTable);
  migratedDb.close();
});


test('fake Meta OAuth, Page lookup, publishing, and customer isolation work end to end', { timeout: 45000 }, async t => {
  const graphPort = await freePort();
  const graphServer = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:' + graphPort);
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const tokenToUser = token => token === 'user-token-alice' ? 'alice' : token === 'user-token-bob' ? 'bob' : null;
    if (url.pathname === '/v26.0/oauth/access_token') {
      const code = url.searchParams.get('code');
      if (code === 'alice-code') return send(200, { access_token: 'user-token-alice' });
      if (code === 'bob-code') return send(200, { access_token: 'user-token-bob' });
      return send(400, { error: { message: 'Unknown test code', code: 100 } });
    }
    if (url.pathname === '/v26.0/me') {
      const user = tokenToUser(url.searchParams.get('access_token'));
      if (!user) return send(400, { error: { message: 'Invalid fake user token', code: 190 } });
      return send(200, { id: 'fb-' + user, name: user === 'alice' ? 'Test Alice' : 'Test Bob' });
    }
    if (url.pathname === '/v26.0/me/accounts') {
      const user = tokenToUser(url.searchParams.get('access_token'));
      if (!user) return send(400, { error: { message: 'Invalid fake user token', code: 190 } });
      return send(200, { data: [{ id: 'page-' + user, name: 'Page ' + user, access_token: 'page-token-' + user, tasks: ['CREATE_CONTENT'] }] });
    }
    if (req.method === 'POST' && /^\/v26\.0\/page-(alice|bob)\/photos$/.test(url.pathname)) {
      for await (const _chunk of req) {}
      return send(200, { id: 'published-photo-' + url.pathname.split('/')[2] });
    }
    if (req.method === 'POST' && /^\/v26\.0\/page-(alice|bob)\/feed$/.test(url.pathname)) {
      for await (const _chunk of req) {}
      return send(200, { id: 'published-feed-' + url.pathname.split('/')[2] });
    }
    return send(404, { error: { message: 'Unexpected fake Graph request: ' + req.method + ' ' + url.pathname } });
  });
  await new Promise((resolve, reject) => graphServer.listen(graphPort, '127.0.0.1', err => err ? reject(err) : resolve()));
  t.after(async () => new Promise(resolve => graphServer.close(() => resolve())));

  const port = await freePort();
  const directory = await import('node:fs/promises').then(fs => fs.mkdtemp(path.join(os.tmpdir(), 'phase2-e2e-')));
  const dbPath = path.join(directory, 'e2e.sqlite');
  const baseUrl = 'http://127.0.0.1:' + port;
  const origin = 'http://phase2-frontend.test';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      APP_BASE_URL: 'https://phase2-backend.test',
      FRONTEND_ORIGIN: origin,
      FRONTEND_SUCCESS_URL: origin + '/',
      META_APP_ID: 'test-app-id',
      META_APP_SECRET: 'test-app-secret',
      SESSION_SECRET: crypto.randomBytes(48).toString('hex'),
      TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
      META_GRAPH_BASE_URL: 'http://127.0.0.1:' + graphPort + '/v26.0',
      TEST_SCHEDULER_CRON: '* * * * * *',
      NODE_ENV: 'test'
    }
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 1500);
    });
    await rm(directory, { recursive: true, force: true });
  });
  await waitForHealth(baseUrl, child);
  const headers = { 'content-type': 'application/json', origin, 'x-forwarded-proto': 'https' };

  async function createAndConnect(email, code) {
    const registration = await fetch(baseUrl + '/api/customer/register', {
      method: 'POST', headers,
      body: JSON.stringify({ email, password: 'a-long-enough-integration-password' })
    });
    assert.equal(registration.status, 201);
    const cookie = registration.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const connectHeaders = { origin, 'x-forwarded-proto': 'https', cookie };
    const start = await fetch(baseUrl + '/auth/facebook', { headers: connectHeaders, redirect: 'manual' });
    assert.equal(start.status, 302);
    const oauthUrl = new URL(start.headers.get('location'));
    const state = oauthUrl.searchParams.get('state');
    assert.ok(state);
    const callback = await fetch(baseUrl + '/auth/facebook/callback?' + new URLSearchParams({ code, state }), {
      headers: connectHeaders, redirect: 'manual'
    });
    assert.equal(callback.status, 302);
    assert.ok(callback.headers.get('location').includes('facebook_connected=1'));
    return cookie;
  }

  const aliceCookie = await createAndConnect('alice@example.com', 'alice-code');
  const bobCookie = await createAndConnect('bob@example.com', 'bob-code');
  const authHeaders = cookie => ({ origin, 'x-forwarded-proto': 'https', cookie });
  const alicePagesResponse = await fetch(baseUrl + '/api/pages', { headers: authHeaders(aliceCookie) });
  const bobPagesResponse = await fetch(baseUrl + '/api/pages', { headers: authHeaders(bobCookie) });
  assert.deepEqual((await alicePagesResponse.json()).pages.map(page => page.id), ['page-alice']);
  assert.deepEqual((await bobPagesResponse.json()).pages.map(page => page.id), ['page-bob']);

  const crossTenantSchedule = await fetch(baseUrl + '/api/schedule', {
    method: 'POST', headers: { ...headers, cookie: aliceCookie },
    body: JSON.stringify({ pageSchedules: [{ pageId: 'page-bob', scheduledAt: new Date(Date.now() + 60000).toISOString() }], images: [{ imageData: 'data:image/jpeg;base64,/9j/2Q==', imageMimeType: 'image/jpeg' }] })
  });
  assert.equal(crossTenantSchedule.status, 400, 'Alice cannot schedule a post to Bob’s Page');

  const publishResponse = await fetch(baseUrl + '/api/publish-now', {
    method: 'POST', headers: { ...headers, cookie: aliceCookie },
    body: JSON.stringify({ pageIds: ['page-alice'], message: 'Automated isolation test', images: [{ imageData: 'data:image/jpeg;base64,/9j/2Q==', imageMimeType: 'image/jpeg' }] })
  });
  assert.equal(publishResponse.status, 201);
  const published = await publishResponse.json();
  assert.equal(published.jobs.length, 1);
  assert.equal(published.jobs[0].status, 'published');

  const scheduledAt = new Date(Date.now() + 16000).toISOString();
  const scheduleResponse = await fetch(baseUrl + '/api/schedule', {
    method: 'POST', headers: { ...headers, cookie: aliceCookie },
    body: JSON.stringify({ pageSchedules: [{ pageId: 'page-alice', scheduledAt }], images: [{ imageData: 'data:image/jpeg;base64,/9j/2Q==', imageMimeType: 'image/jpeg' }], message: 'Automated scheduled publish test' })
  });
  assert.equal(scheduleResponse.status, 201);
  const scheduleData = await scheduleResponse.json();
  const scheduledJobId = scheduleData.jobs[0].id;
  const pollDeadline = Date.now() + 26000;
  let scheduledStatus = 'scheduled';
  while (Date.now() < pollDeadline && !['published', 'failed', 'missing'].includes(scheduledStatus)) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const db = new Database(dbPath);
    scheduledStatus = db.prepare('SELECT status FROM jobs WHERE id=?').get(scheduledJobId)?.status || 'missing';
    db.close();
  }
  assert.equal(scheduledStatus, 'published', 'the background scheduler should publish due jobs in the isolated test environment');

  const aliceJobs = await fetch(baseUrl + '/api/jobs', { headers: authHeaders(aliceCookie) });
  const bobJobs = await fetch(baseUrl + '/api/jobs', { headers: authHeaders(bobCookie) });
  assert.equal((await aliceJobs.json()).jobs.length, 2);
  assert.equal((await bobJobs.json()).jobs.length, 0, 'Bob cannot see Alice’s publishing history');
});
