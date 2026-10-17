import test from 'node:test';
import assert from 'node:assert/strict';
import { hashCustomerPassword, verifyCustomerPassword, normalizeCustomerEmail, customerIdFromSession } from '../customer-auth.js';

test('passwords are stored as salted scrypt verifiers and verify correctly', async () => {
  const encoded = await hashCustomerPassword('correct-horse-battery');
  assert.match(encoded, /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.equal(await verifyCustomerPassword('correct-horse-battery', encoded), true);
  assert.equal(await verifyCustomerPassword('wrong-password', encoded), false);
  assert.notEqual(await hashCustomerPassword('correct-horse-battery'), encoded);
});

test('password helper rejects weak and malformed input', async () => {
  await assert.rejects(() => hashCustomerPassword('short'));
  assert.equal(await verifyCustomerPassword('anything', 'not-a-valid-hash'), false);
  assert.equal(await verifyCustomerPassword('x'.repeat(129), 'not-a-valid-hash'), false);
});

test('email normalization validates and lowercases', () => {
  assert.equal(normalizeCustomerEmail('  Person@Example.COM '), 'person@example.com');
  assert.equal(normalizeCustomerEmail('not-an-email'), null);
  assert.equal(normalizeCustomerEmail(null), null);
});

test('customer ID is read only from authenticated server session', () => {
  assert.equal(customerIdFromSession({ session: { customerAccount: { id: 'customer-1' } }, body: { customerId: 'customer-2' } }), 'customer-1');
  assert.equal(customerIdFromSession({ session: { fbUser: { id: 'facebook-id' } } }), null);
});
