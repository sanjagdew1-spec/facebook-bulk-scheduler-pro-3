import crypto from 'node:crypto';

function readEncryptionKey(raw = process.env.TOKEN_ENCRYPTION_KEY) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('TOKEN_ENCRYPTION_KEY is required for Facebook token storage.');
  const value = raw.trim();
  let key;
  if (/^[a-f0-9]{64}$/i.test(value)) key = Buffer.from(value, 'hex');
  else key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex characters or a base64-encoded 32-byte key).');
  return key;
}

export function isTokenEncryptionConfigured(raw = process.env.TOKEN_ENCRYPTION_KEY) {
  try { readEncryptionKey(raw); return true; } catch { return false; }
}

export function encryptToken(token, rawKey = process.env.TOKEN_ENCRYPTION_KEY) {
  if (typeof token !== 'string' || !token) throw new TypeError('A non-empty token is required.');
  const key = readEncryptionKey(rawKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['enc:v1', iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
}

export function decryptToken(value, rawKey = process.env.TOKEN_ENCRYPTION_KEY) {
  if (typeof value !== 'string' || !value.startsWith('enc:v1:')) {
    throw new Error('Stored Facebook token is not encrypted in the supported format. Reconnect the Facebook account.');
  }
  const parts = value.split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') throw new Error('Stored Facebook token format is invalid.');
  const key = readEncryptionKey(rawKey);
  const iv = Buffer.from(parts[2], 'base64');
  const tag = Buffer.from(parts[3], 'base64');
  const ciphertext = Buffer.from(parts[4], 'base64');
  if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) throw new Error('Stored Facebook token format is invalid.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
