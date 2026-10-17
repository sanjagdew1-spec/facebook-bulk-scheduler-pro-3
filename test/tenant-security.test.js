import test from 'node:test';
import assert from 'node:assert/strict';
import { getCustomerId, requireCustomerAuth, findCustomerPage, findCustomerJob } from '../tenant-security.js';

test('customer identity comes only from the server-side session', () => {
  assert.equal(getCustomerId({ session: { customerAccount: { id: 'cust-a' } }, body: { customerId: 'cust-b' } }), 'cust-a');
  assert.equal(getCustomerId({ session: { fbUser: { id: 'facebook-user' } } }), null);
  assert.equal(getCustomerId({ session: { customerAccount: { id: '' } } }), null);
});

test('customer route guard rejects missing customer session', () => {
  let statusCode = 0;
  let payload;
  let nextCalled = false;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return this; }
  };
  requireCustomerAuth({ session: {} }, res, () => { nextCalled = true; });
  assert.equal(statusCode, 401);
  assert.equal(payload.error, 'Sign in to your customer account first.');
  assert.equal(nextCalled, false);
});

test('customer route guard permits a signed-in customer', () => {
  let nextCalled = false;
  requireCustomerAuth({ session: { customerAccount: { id: 'cust-a' } } }, {
    status() { throw new Error('should not reject'); },
    json() { throw new Error('should not reject'); }
  }, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('page lookup is explicitly scoped to customer and page ID', () => {
  let sql, params;
  const db = { prepare(statement) { sql = statement; return { get(...args) { params = args; return null; } }; } };
  assert.equal(findCustomerPage(db, 'cust-a', 'page-1'), null);
  assert.match(sql, /customer_id\s*=\s*\?\s+AND\s+page_id\s*=\s*\?/);
  assert.deepEqual(params, ['cust-a', 'page-1']);
  assert.equal(findCustomerPage(db, '', 'page-1'), null);
});

test('job lookup is explicitly scoped to customer and job ID', () => {
  let sql, params;
  const db = { prepare(statement) { sql = statement; return { get(...args) { params = args; return null; } }; } };
  assert.equal(findCustomerJob(db, 'cust-a', 'job-1'), null);
  assert.match(sql, /customer_id\s*=\s*\?\s+AND\s+id\s*=\s*\?/);
  assert.deepEqual(params, ['cust-a', 'job-1']);
  assert.equal(findCustomerJob(db, null, 'job-1'), null);
});
