import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCustomerAuthRoutes } from '../customer-auth-routes.js';

function makeHarness() {
  const routes = new Map();
  const app = {
    post(path, ...handlers) { routes.set('POST ' + path, handlers); },
    get(path, ...handlers) { routes.set('GET ' + path, handlers); }
  };
  const inserted = [];
  const db = {
    transaction(callback) { return (...args) => callback(...args); },
    prepare(sql) {
      if (sql.startsWith('SELECT id FROM customer_accounts')) return { get: () => null };
      if (sql.startsWith('SELECT COUNT(*) AS count FROM customer_accounts')) return { get: () => ({ count: inserted.length }) };
      if (sql.startsWith('INSERT INTO customer_accounts')) return { run: (...args) => inserted.push(args) };
      throw new Error('Unexpected SQL in test: ' + sql);
    }
  };
  registerCustomerAuthRoutes(app, { db, trustedOrigins: new Set(['https://phase2.example.test']) });
  return { routes, inserted };
}

async function invoke(handlers, req) {
  const state = { statusCode: 200, body: null, headers: {}, clearedCookie: null };
  const res = {
    status(code) { state.statusCode = code; return this; },
    json(value) { state.body = value; return this; },
    setHeader(name, value) { state.headers[name] = value; },
    clearCookie(name, options) { state.clearedCookie = { name, options }; return this; }
  };
  for (const handler of handlers) {
    let nextCalled = false;
    await handler(req, res, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return { ...state, req };
}

function makeRequest(overrides = {}) {
  const session = {
    regenerate(callback) { this.customerAccount = undefined; callback(null); },
    save(callback) { callback(null); },
    destroy(callback) { callback(null); }
  };
  return {
    headers: { origin: 'https://phase2.example.test' },
    ip: 'test-client',
    socket: { remoteAddress: 'test-client' },
    body: { email: 'Tester@Example.com', password: 'a-long-enough-test-password' },
    session,
    ...overrides
  };
}

test('registration rejects requests without a trusted Origin', async () => {
  const { routes, inserted } = makeHarness();
  const result = await invoke(routes.get('POST /api/customer/register'), makeRequest({ headers: {} }));
  assert.equal(result.statusCode, 403);
  assert.equal(inserted.length, 0);
});

test('registration normalizes email, stores a password verifier, and creates a server session', async () => {
  const { routes, inserted } = makeHarness();
  const result = await invoke(routes.get('POST /api/customer/register'), makeRequest());
  assert.equal(result.statusCode, 201);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.customer.email, 'tester@example.com');
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0][1], 'tester@example.com');
  assert.match(inserted[0][2], /^user_[a-f0-9]{8}$/);
  assert.match(inserted[0][3], /^scrypt\\$[a-f0-9]{32}\\$[a-f0-9]{128}$/);
  assert.equal(inserted[0][4], 'active');
  assert.equal(result.body.customer.username, inserted[0][2]);
  assert.equal(result.req.session.customerAccount.id, result.body.customer.id);
});

test('registration rejects short passwords before writing account data', async () => {
  const { routes, inserted } = makeHarness();
  const result = await invoke(routes.get('POST /api/customer/register'), makeRequest({ body: { email: 'tester@example.com', password: 'short' } }));
  assert.equal(result.statusCode, 400);
  assert.equal(inserted.length, 0);
});
