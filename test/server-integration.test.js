import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
  const headers = { 'content-type': 'application/json', origin, 'x-forwarded-proto': 'https' };
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
