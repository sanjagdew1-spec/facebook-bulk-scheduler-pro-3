import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptToken, decryptToken, isTokenEncryptionConfigured } from '../token-crypto.js';

const key = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('token encryption round-trips with AES-256-GCM and does not store plaintext', () => {
  const original = 'EAAB-facebook-secret-token';
  const encrypted = encryptToken(original, key);
  assert.match(encrypted, /^enc:v1:/);
  assert.equal(encrypted.includes(original), false);
  assert.equal(decryptToken(encrypted, key), original);
});

test('token encryption uses a fresh IV and rejects a wrong key', () => {
  const first = encryptToken('same-token', key);
  const second = encryptToken('same-token', key);
  assert.notEqual(first, second);
  assert.throws(() => decryptToken(first, 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'), /authenticate|Unsupported state|bad decrypt/i);
});

test('token encryption fails closed for missing or invalid keys and plaintext values', () => {
  assert.equal(isTokenEncryptionConfigured(''), false);
  assert.equal(isTokenEncryptionConfigured(key), true);
  assert.throws(() => encryptToken('token', ''), /TOKEN_ENCRYPTION_KEY is required/);
  assert.throws(() => decryptToken('EAAB-plaintext-token', key), /not encrypted/);
});
