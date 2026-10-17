import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

/** Store only a salted scrypt verifier, never the original password. */
export async function hashCustomerPassword(password) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
    throw new TypeError('Password must be 10–128 characters long.');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return 'scrypt$' + salt + '$' + Buffer.from(key).toString('hex');
}

/** Timing-safe password verification. Malformed hashes fail closed. */
export async function verifyCustomerPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 128 || typeof encoded !== 'string') return false;
  const parts = encoded.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt' ||
      !/^[a-f0-9]{32}$/.test(parts[1]) || !/^[a-f0-9]{128}$/.test(parts[2])) return false;
  const actual = Buffer.from(await scrypt(password, parts[1], 64));
  const expected = Buffer.from(parts[2], 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function normalizeCustomerEmail(email) {
  if (typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  return normalized;
}

/** Customer IDs must be obtained from the authenticated server-side session. */
export function customerIdFromSession(req) {
  const id = req?.session?.customerAccount?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
