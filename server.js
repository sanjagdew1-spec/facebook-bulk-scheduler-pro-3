import express from 'express';
import session from 'express-session';
import SQLiteStoreFactory from 'better-sqlite3-session-store';
import Database from 'better-sqlite3';
import cron from 'node-cron';
import crypto from 'node:crypto';
import path from 'node:path';
import { registerCustomerAuthRoutes } from './customer-auth-routes.js';
import { encryptToken, decryptToken, isTokenEncryptionConfigured } from './token-crypto.js';

const app = express();
const PORT = process.env.PORT || 3000;
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'https://sanjagdew1-spec.github.io';
const META_APP_ID_RAW = process.env.META_APP_ID || '';
const META_APP_SECRET_RAW = process.env.META_APP_SECRET || '';
const META_APP_ID = META_APP_ID_RAW.trim();
const META_APP_SECRET = META_APP_SECRET_RAW.trim();
const META_LOGIN_CONFIG_ID = (process.env.META_LOGIN_CONFIG_ID || '').trim();
const FRONTEND_SUCCESS_URL = process.env.FRONTEND_SUCCESS_URL || 'https://sanjagdew1-spec.github.io/facebook-bulk-scheduler-pro-3/';
const GRAPH_VERSION = 'v26.0';
// Allow a local fake Graph API only in automated tests; production always uses Meta's official endpoint.
const GRAPH_BASE_URL = process.env.NODE_ENV === 'test' && process.env.META_GRAPH_BASE_URL
  ? process.env.META_GRAPH_BASE_URL.replace(/\/$/, '')
  : `https://graph.facebook.com/${GRAPH_VERSION}`;
const DB_PATH = process.env.DB_PATH || './scheduler.sqlite';

// Safe startup diagnostics: report configuration presence only; never print secrets or tokens.
console.log('[config-check]', JSON.stringify({
  metaAppIdPresent: Boolean(META_APP_ID),
  metaAppIdLength: META_APP_ID.length,
  loginConfigIdPresent: Boolean(META_LOGIN_CONFIG_ID),
  appBaseUrlPresent: Boolean(APP_BASE_URL),
  callbackUrl: APP_BASE_URL ? `${APP_BASE_URL}/auth/facebook/callback` : null,
  tokenEncryptionConfigured: isTokenEncryptionConfigured(),
  sessionSecretPresent: Boolean(process.env.SESSION_SECRET)
}));

if (process.env.NODE_ENV === 'production') {
  const missing = [];
  if (!process.env.DB_PATH || !path.isAbsolute(DB_PATH)) missing.push('DB_PATH (absolute path on a persistent disk)');
  if (!META_APP_ID) missing.push('META_APP_ID');
  if (!META_APP_SECRET) missing.push('META_APP_SECRET');
  if (!APP_BASE_URL) missing.push('APP_BASE_URL');
  if (!process.env.SESSION_SECRET) missing.push('SESSION_SECRET');
  if (!isTokenEncryptionConfigured()) missing.push('TOKEN_ENCRYPTION_KEY');
  if (missing.length) throw new Error('Phase 2 production configuration is incomplete: ' + missing.join(', '));
} else if (!META_APP_ID || !META_APP_SECRET || !APP_BASE_URL || !process.env.SESSION_SECRET || !isTokenEncryptionConfigured()) {
  console.warn('Missing one or more required environment variables: META_APP_ID, META_APP_SECRET, APP_BASE_URL, SESSION_SECRET, TOKEN_ENCRYPTION_KEY');
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS customer_accounts (
  id TEXT PRIMARY KEY,
  email_normalized TEXT NOT NULL UNIQUE,
  username TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS customer_facebook_connections (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  facebook_user_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  access_token TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(customer_id, facebook_user_id),
  FOREIGN KEY(customer_id) REFERENCES customer_accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS customer_fb_user_idx ON customer_facebook_connections(facebook_user_id);
CREATE TABLE IF NOT EXISTS customer_pages (
  customer_id TEXT NOT NULL,
  facebook_user_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  name TEXT NOT NULL,
  access_token TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (customer_id, page_id),
  FOREIGN KEY(customer_id) REFERENCES customer_accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS customer_pages_fb_user_idx ON customer_pages(customer_id, facebook_user_id);
CREATE TABLE IF NOT EXISTS pages (
  user_id TEXT NOT NULL, page_id TEXT NOT NULL, name TEXT NOT NULL,
  access_token TEXT NOT NULL, updated_at TEXT NOT NULL,
  customer_id TEXT,
  PRIMARY KEY (user_id, page_id)
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, page_id TEXT NOT NULL,
  page_name TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', image_url TEXT NOT NULL DEFAULT '',
  image_data BLOB, image_mime_type TEXT,
  scheduled_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled',
  post_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  customer_id TEXT
);
CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs(status, scheduled_at);
CREATE TABLE IF NOT EXISTS job_images (
  job_id TEXT NOT NULL, position INTEGER NOT NULL, image_data BLOB NOT NULL, image_mime_type TEXT NOT NULL,
  PRIMARY KEY (job_id, position), FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS job_images_job_idx ON job_images(job_id, position);
`);
for (const migration of [
  'ALTER TABLE customer_accounts ADD COLUMN username TEXT',
  'ALTER TABLE jobs ADD COLUMN image_data BLOB',
  'ALTER TABLE jobs ADD COLUMN image_mime_type TEXT',
  'ALTER TABLE jobs ADD COLUMN is_ai_content INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE jobs ADD COLUMN customer_id TEXT',
  'ALTER TABLE pages ADD COLUMN customer_id TEXT'
]) {
  try { db.exec(migration); }
  catch (e) { if (!String(e.message || e).includes('duplicate column name')) throw e; }
}
// Backfill stable, unique usernames for existing pilot accounts.
const accountsMissingUsername = db.prepare("SELECT id FROM customer_accounts WHERE username IS NULL OR username = ''").all();
const usernameExists = db.prepare('SELECT id FROM customer_accounts WHERE username = ?');
const setUsername = db.prepare('UPDATE customer_accounts SET username = ? WHERE id = ?');
for (const account of accountsMissingUsername) {
  let username;
  do { username = 'user_' + crypto.randomBytes(4).toString('hex'); } while (usernameExists.get(username));
  setUsername.run(username, account.id);
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS customer_accounts_username_idx ON customer_accounts(username)');

db.exec('CREATE INDEX IF NOT EXISTS pages_customer_idx ON pages(customer_id, page_id)');
db.exec('CREATE INDEX IF NOT EXISTS jobs_customer_idx ON jobs(customer_id, scheduled_at)');

app.set('trust proxy', 1);
// GitHub Pages and Render are different origins. Allow the project site to call this API
// while preserving session cookies; never allow arbitrary origins.
app.use((req, res, next) => {
  const allowedOrigins = new Set([
    FRONTEND_ORIGIN,
    'https://sanjagdew1-spec.github.io'
  ]);
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '50mb' }));
app.use(session({
  name: 'fb_scheduler_sid',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  store: new (SQLiteStoreFactory(session))( { client: db, expired: { clear: true, intervalMs: 15 * 60 * 1000 } } ),
  cookie: { httpOnly: true, secure: true, sameSite: 'none', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

registerCustomerAuthRoutes(app, { db, trustedOrigins: new Set([FRONTEND_ORIGIN, 'https://sanjagdew1-spec.github.io']) });

const graph = (path) => `${GRAPH_BASE_URL}/${path}`;
const now = () => new Date().toISOString();
const scopes = ['public_profile', 'pages_show_list', 'pages_manage_posts', 'pages_read_engagement'];

const TRUSTED_ORIGINS = new Set([FRONTEND_ORIGIN, 'https://sanjagdew1-spec.github.io']);
function requireTrustedOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (!origin || !TRUSTED_ORIGINS.has(origin)) {
    return res.status(403).json({ error: 'Request origin could not be verified. Open the official app and try again.' });
  }
  next();
}
app.get('/health', (_req, res) => res.json({ ok: true, service: 'Facebook Bulk Scheduler Pro 3', timestamp: now() }));
app.get('/config/status', (_req, res) => res.json({
  configured: Boolean(META_APP_ID && META_APP_SECRET && APP_BASE_URL && process.env.SESSION_SECRET && isTokenEncryptionConfigured()),
  appIdPresent: Boolean(META_APP_ID), appSecretPresent: Boolean(META_APP_SECRET),
  appIdLength: META_APP_ID.length, appSecretLength: META_APP_SECRET.length,
  appIdHasOuterWhitespace: META_APP_ID_RAW !== META_APP_ID,
  appSecretHasOuterWhitespace: META_APP_SECRET_RAW !== META_APP_SECRET,
  loginConfigIdPresent: Boolean(META_LOGIN_CONFIG_ID), tokenEncryptionConfigured: isTokenEncryptionConfigured(),
  callbackUrl: `${APP_BASE_URL}/auth/facebook/callback`, graphVersion: GRAPH_VERSION,
  note: 'Page publishing requires Meta app access and approval for requested permissions.'
}));

app.get('/auth/facebook', (req, res) => {
  if (!req.session.customerAccount?.id) return res.status(401).send('Sign in to your customer account before connecting Facebook.');
  if (!isTokenEncryptionConfigured()) return res.status(503).send('Facebook token encryption is not configured on this Phase 2 service yet.');
  if (!META_APP_ID || !APP_BASE_URL) return res.status(500).json({ error: 'Facebook login is not configured on the server.' });
  const state = crypto.randomBytes(24).toString('hex');
  req.session.oauthState = state;
  req.session.oauthCustomerId = req.session.customerAccount.id;
  const oauthParams = { client_id: META_APP_ID, redirect_uri: `${APP_BASE_URL}/auth/facebook/callback`, state, response_type: 'code' };
  if (META_LOGIN_CONFIG_ID) {
    // Login for Business configurations define the requested permissions in Meta.
    oauthParams.config_id = META_LOGIN_CONFIG_ID;
    oauthParams.override_default_response_type = 'true';
  } else {
    // Fallback for standard Facebook Login; use only if this app is configured for it.
    oauthParams.scope = scopes.join(',');
  }
  const params = new URLSearchParams(oauthParams);
  const loginUrl = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
  // Persist OAuth state before leaving this domain so callback verification can find it.
  req.session.save((err) => {
    if (err) {
      console.error('[oauth-start] Could not save login session:', String(err.message || err));
      return res.status(500).send('Could not start Facebook login because the session could not be saved. Please try again.');
    }
    res.redirect(loginUrl);
  });
});

app.get('/auth/facebook/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;
  if (error) return res.status(400).send(`Facebook login failed: ${String(errorDescription || error)}. You can close this tab and return to the app.`);
  if (!code || !state || state !== req.session.oauthState || !req.session.customerAccount?.id || req.session.oauthCustomerId !== req.session.customerAccount.id) return res.status(400).send('Login could not be verified for this customer account. Please return to the app and try Connect with Facebook again.');
  delete req.session.oauthState;
  delete req.session.oauthCustomerId;
  try {
    const tokenUrl = new URL(graph('oauth/access_token'));
    tokenUrl.search = new URLSearchParams({ client_id: META_APP_ID, client_secret: META_APP_SECRET, redirect_uri: `${APP_BASE_URL}/auth/facebook/callback`, code: String(code) }).toString();
    const tokenResponse = await fetch(tokenUrl);
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) {
      const metaError = tokenData.error || {};
      console.error('[oauth-token-exchange] Meta rejected token exchange', JSON.stringify({
        httpStatus: tokenResponse.status,
        errorType: metaError.type || null,
        errorCode: metaError.code || null,
        errorSubcode: metaError.error_subcode || null,
        message: metaError.message || 'Unknown Meta token-exchange error',
        fbtraceId: metaError.fbtrace_id || null,
        appIdPresent: Boolean(META_APP_ID),
        appSecretPresent: Boolean(META_APP_SECRET),
        appIdLength: META_APP_ID.length,
        appSecretLength: META_APP_SECRET.length,
        appIdHasOuterWhitespace: META_APP_ID_RAW !== META_APP_ID,
        appSecretHasOuterWhitespace: META_APP_SECRET_RAW !== META_APP_SECRET
      }));
      const details = [metaError.message || 'Could not exchange the login code for an access token.'];
      if (metaError.code != null) details.push(`Meta code ${metaError.code}`);
      if (metaError.error_subcode != null) details.push(`subcode ${metaError.error_subcode}`);
      throw new Error(details.join(' | '));
    }
    const meResponse = await fetch(`${graph('me')}?${new URLSearchParams({ fields: 'id,name', access_token: tokenData.access_token })}`);
    const me = await meResponse.json();
    if (!meResponse.ok || !me.id) throw new Error(me.error?.message || 'Could not read the Facebook account.');
    const customerId = req.session.customerAccount.id;
    const facebookUserId = String(me.id);
    const connectedAt = now();
    db.prepare('INSERT INTO customer_facebook_connections(id,customer_id,facebook_user_id,display_name,access_token,connected_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(customer_id,facebook_user_id) DO UPDATE SET display_name=excluded.display_name,access_token=excluded.access_token,updated_at=excluded.updated_at')
      .run(crypto.randomUUID(), customerId, facebookUserId, me.name || 'Facebook user', encryptToken(tokenData.access_token), connectedAt, connectedAt);
    req.session.fbUser = { id: facebookUserId, name: me.name || 'Facebook user', customerId };
    await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
    res.redirect(`${FRONTEND_SUCCESS_URL}?facebook_connected=1`);

 } catch (e) {
    res.status(400).send(`Facebook connection failed: ${String(e.message || e)}. Check Meta app status, OAuth redirect URI, and permission access.`);
  }
});

app.get('/auth/status', (req, res) => {
  const connectedUser = req.session.customerAccount?.id && req.session.fbUser?.customerId === req.session.customerAccount.id ? req.session.fbUser : null;
  res.json({ connected: Boolean(connectedUser), user: connectedUser ? { id: connectedUser.id, name: connectedUser.name } : null });
});
app.post('/auth/logout', requireTrustedOrigin, (req, res) => req.session.destroy(err => err ? res.status(500).json({ error: 'Could not log out.' }) : res.json({ ok: true })));

function requireAuth(req, res, next) {
  const customerId = req.session.customerAccount?.id;
  if (!customerId) return res.status(401).json({ error: 'Sign in to your customer account first.' });
  const customer = db.prepare('SELECT id,status FROM customer_accounts WHERE id=?').get(customerId);
  if (!customer || customer.status !== 'active') {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'This customer account is not active. Sign in again or contact support.' });
  }
  if (!req.session.fbUser || req.session.fbUser.customerId !== customerId) return res.status(401).json({ error: 'Connect Facebook to this customer account first.' });
  next();
}

app.get('/api/pages', requireAuth, async (req, res) => {
  try {
    const u = req.session.fbUser;
    const connection = db.prepare('SELECT access_token FROM customer_facebook_connections WHERE customer_id=? AND facebook_user_id=?').get(req.session.customerAccount.id, u.id);
    if (!connection) return res.status(401).json({ pages: [], diagnostic: { source: 'backend', message: 'Facebook is not linked to this customer account. Reconnect Facebook.' } });
    let facebookAccessToken;
    try { facebookAccessToken = decryptToken(connection.access_token); }
    catch { return res.status(503).json({ pages: [], diagnostic: { source: 'backend', message: 'The stored Facebook connection needs to be reconnected before Pages can be loaded.' } }); }
    const pageParams = { fields: 'id,name,access_token,tasks', limit: '100', access_token: facebookAccessToken };
    const url = `${graph('me/accounts')}?${new URLSearchParams(pageParams)}`;
    const response = await fetch(url);
    const data = await response.json();

    // Diagnostic output intentionally excludes access tokens, IDs, and other secrets.
    if (!response.ok || data.error) {
      const err = data.error || {};
      console.error('[pages-api] Meta rejected Page lookup', JSON.stringify({
        httpStatus: response.status,
        errorType: err.type || null,
        errorCode: err.code || null,
        errorSubcode: err.error_subcode || null,
        message: err.message || 'Unknown Meta API error'
      }));
      return res.status(502).json({
        pages: [],
        diagnostic: {
          source: 'Meta Graph API',
          httpStatus: response.status,
          errorType: err.type || null,
          errorCode: err.code || null,
          errorSubcode: err.error_subcode || null,
          message: err.message || 'Meta did not return Pages.'
        }
      });
    }

    const rawPages = Array.isArray(data.data) ? [...data.data] : [];
    // Follow Meta cursor pagination so large Page portfolios are not silently truncated.
    let after = data.paging?.cursors?.after || null;
    let hasNextPage = Boolean(data.paging?.next);
    let pageFetchCount = 1;
    while (hasNextPage && after && pageFetchCount < 10 && rawPages.length < 1000) {
      const nextParams = { ...pageParams, after };
      const nextResponse = await fetch(`${graph('me/accounts')}?${new URLSearchParams(nextParams)}`);
      const nextData = await nextResponse.json();
      if (!nextResponse.ok || nextData.error) {
        const err = nextData.error || {};
        console.warn('[pages-api] Page pagination stopped after a Meta error', JSON.stringify({ httpStatus: nextResponse.status, errorCode: err.code || null, message: err.message || 'Unknown Meta API error' }));
        break;
      }
      const nextRows = Array.isArray(nextData.data) ? nextData.data : [];
      if (!nextRows.length) break;
      rawPages.push(...nextRows);
      const nextAfter = nextData.paging?.cursors?.after || null;
      hasNextPage = Boolean(nextData.paging?.next && nextAfter && nextAfter !== after);
      after = nextAfter;
      pageFetchCount++;
    }
    const uniqueRawPages = [...new Map(rawPages.filter(p => p?.id).map(p => [String(p.id), p])).values()];
    const pages = uniqueRawPages.map(p => ({ id: String(p.id), name: p.name, tasks: p.tasks || [] }));
    const save = db.prepare('INSERT INTO customer_pages(customer_id,facebook_user_id,page_id,name,access_token,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(customer_id,page_id) DO UPDATE SET facebook_user_id=excluded.facebook_user_id,name=excluded.name,access_token=excluded.access_token,updated_at=excluded.updated_at');
    const tx = db.transaction(() => { for (const p of uniqueRawPages) {
      if (p.id && p.access_token) save.run(req.session.customerAccount.id, u.id, String(p.id), p.name || 'Facebook Page', encryptToken(p.access_token), now());
    } });
    tx();

    const diagnostic = {
      source: 'Meta Graph API',
      httpStatus: response.status,
      returnedCount: pages.length,
      hasPaging: Boolean(data.paging),
      hasNextPage: hasNextPage,
      pagesFetchedIn: pageFetchCount,
      note: pages.length ? 'Page records received from Meta; cursor pagination was followed where available.' : 'Meta returned a successful response with zero Page records. This is not a server crash; check which access the current Facebook login actually grants.'
    };
    if (!pages.length) console.warn('[pages-api] Meta returned zero Pages', JSON.stringify(diagnostic));
    res.json({ pages, diagnostic });
  } catch (e) {
    console.error('[pages-api] Unexpected server error', String(e.message || e));
    res.status(500).json({ pages: [], diagnostic: { source: 'backend', message: 'Unexpected server error while loading Pages.' } });
  }
});

app.get('/api/jobs', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id,page_id,page_name,message,image_url,scheduled_at,status,post_id,error,is_ai_content,created_at,updated_at FROM jobs WHERE customer_id=? AND user_id=? ORDER BY scheduled_at DESC LIMIT 500').all(req.session.customerAccount.id, req.session.fbUser.id);
  res.json({ jobs: rows });
});

app.post('/api/schedule', requireTrustedOrigin, requireAuth, (req, res) => {
  const { pageIds, pageSchedules, imageUrl = '', imageData = '', imageMimeType = '', images: incomingImages = [], message = '', scheduledAt, isAiContent = false } = req.body || {};
  const requestedSchedules = Array.isArray(pageSchedules) && pageSchedules.length
    ? pageSchedules.map(item => ({ pageId: item?.pageId, scheduledAt: item?.scheduledAt }))
    : (Array.isArray(pageIds) ? pageIds.map(pageId => ({ pageId, scheduledAt })) : []);
  if (!requestedSchedules.length || requestedSchedules.some(item => (typeof item.pageId !== 'string' && typeof item.pageId !== 'number') || typeof item.scheduledAt !== 'string')) return res.status(400).json({ error: 'Select Pages and set a schedule time for each selected Page.' });
  const uniqueRequestedIds = new Set(requestedSchedules.map(item => String(item.pageId)));
  if (uniqueRequestedIds.size !== requestedSchedules.length) return res.status(400).json({ error: 'A Page was selected more than once. Refresh the Page list and try again.' });
  const validatedSchedules = requestedSchedules.map(item => ({ pageId: String(item.pageId), date: new Date(item.scheduledAt) }));
  if (validatedSchedules.some(item => !item.date || Number.isNaN(item.date.getTime()) || item.date.getTime() < Date.now() + 15_000)) {
    return res.status(400).json({ error: 'Every selected Page must have a valid future schedule time at least 15 seconds from now.' });
  }
  if (!Array.isArray(incomingImages) || incomingImages.length > 10) return res.status(400).json({ error: 'Choose no more than 10 photos per post.' });
  const photos = [];
  const inputs = incomingImages.length ? incomingImages : (imageData ? [{ imageData, imageMimeType }] : []);
  let totalBytes = 0;
  for (const photo of inputs) {
    if (!photo || typeof photo.imageData !== 'string') return res.status(400).json({ error: 'Choose valid JPG or PNG photo files.' });
    const match = photo.imageData.match(/^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return res.status(400).json({ error: 'Choose a valid JPG or PNG image file.' });
    const mime = match[1];
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > 6 * 1024 * 1024) return res.status(400).json({ error: 'Each photo must be smaller than 6 MB.' });
    if (photo.imageMimeType && photo.imageMimeType !== mime) return res.status(400).json({ error: 'Image type mismatch. Please select the image again.' });
    totalBytes += buffer.length;
    photos.push({ buffer, mime });
  }
  if (totalBytes > 30 * 1024 * 1024) return res.status(400).json({ error: 'The combined size of all photos must be 30 MB or less.' });
  if (!photos.length && (typeof imageUrl !== 'string' || !/^https:\/\//i.test(imageUrl))) return res.status(400).json({ error: 'Upload JPG/PNG photos or provide a public HTTPS image URL.' });
  const invalidTime = validatedSchedules.find(item => !item.date || Number.isNaN(item.date.getTime()) || item.date.getTime() < Date.now() + 15_000);
  if (invalidTime) return res.status(400).json({ error: 'Every selected Page must have a valid future schedule time at least 15 seconds from now.' });
  const insert = db.prepare("INSERT INTO jobs(id,user_id,page_id,page_name,message,image_url,image_data,image_mime_type,scheduled_at,status,is_ai_content,created_at,updated_at,customer_id) VALUES(?,?,?,?,?,?,?,?,?,'scheduled',?,?,?,?)");
  const insertPhoto = db.prepare('INSERT INTO job_images(job_id,position,image_data,image_mime_type) VALUES(?,?,?,?)');
  const created = [];
  const tx = db.transaction(() => {
    for (const requested of validatedSchedules) {
      const page = db.prepare('SELECT page_id,name FROM customer_pages WHERE customer_id=? AND facebook_user_id=? AND page_id=?').get(req.session.customerAccount.id, req.session.fbUser.id, requested.pageId);
      if (!page) throw new Error('Page ' + requested.pageId + ' was not found for this Facebook account. Refresh the Page list and try again.');
      const id = crypto.randomUUID();
      const first = photos[0] || null;
      const pageScheduledAt = requested.date.toISOString();
      insert.run(id, req.session.fbUser.id, page.page_id, page.name, String(message), first ? '' : imageUrl, first ? first.buffer : null, first ? first.mime : null, pageScheduledAt, isAiContent ? 1 : 0, now(), now(), req.session.customerAccount.id);
      photos.forEach((photo,index) => insertPhoto.run(id,index,photo.buffer,photo.mime));
      created.push({ id, pageId: page.page_id, pageName: page.name, scheduledAt: pageScheduledAt, status: 'scheduled', photoCount: photos.length || 1 });
    }
  });
  try { tx(); res.status(201).json({ jobs: created, requestedCount: validatedSchedules.length, createdCount: created.length }); } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

app.post('/api/publish-now', requireTrustedOrigin, requireAuth, async (req, res) => {
  const { pageIds, imageUrl = '', images: incomingImages = [], message = '', isAiContent = false } = req.body || {};
  if (!Array.isArray(pageIds) || !pageIds.length) return res.status(400).json({ error: 'Select at least one Page.' });
  const ids = pageIds.map(String);
  if (new Set(ids).size !== ids.length) return res.status(400).json({ error: 'A Page was selected more than once. Refresh the Page list and try again.' });
  if (!Array.isArray(incomingImages) || incomingImages.length > 10) return res.status(400).json({ error: 'Choose no more than 10 photos per post.' });

  const photos = [];
  let totalBytes = 0;
  for (const photo of incomingImages) {
    if (!photo || typeof photo.imageData !== 'string') return res.status(400).json({ error: 'Choose valid JPG or PNG photo files.' });
    const match = photo.imageData.match(/^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return res.status(400).json({ error: 'Choose a valid JPG or PNG image file.' });
    const mime = match[1];
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > 6 * 1024 * 1024) return res.status(400).json({ error: 'Each photo must be smaller than 6 MB.' });
    if (photo.imageMimeType && photo.imageMimeType !== mime) return res.status(400).json({ error: 'Image type mismatch. Please select the image again.' });
    totalBytes += buffer.length;
    photos.push({ buffer, mime });
  }
  if (totalBytes > 30 * 1024 * 1024) return res.status(400).json({ error: 'The combined size of all photos must be 30 MB or less.' });
  if (!photos.length && (typeof imageUrl !== 'string' || !/^https:\/\//i.test(imageUrl))) return res.status(400).json({ error: 'Upload JPG/PNG photos or provide a public HTTPS image URL.' });

  const insert = db.prepare("INSERT INTO jobs(id,user_id,page_id,page_name,message,image_url,image_data,image_mime_type,scheduled_at,status,is_ai_content,created_at,updated_at,customer_id) VALUES(?,?,?,?,?,?,?,?,?,'scheduled',?,?,?,?)");
  const insertPhoto = db.prepare('INSERT INTO job_images(job_id,position,image_data,image_mime_type) VALUES(?,?,?,?)');
  const created = [];
  const publishTime = now();
  try {
    const tx = db.transaction(() => {
      for (const pageId of ids) {
        const page = db.prepare('SELECT page_id,name FROM customer_pages WHERE customer_id=? AND facebook_user_id=? AND page_id=?').get(req.session.customerAccount.id, req.session.fbUser.id, pageId);
        if (!page) throw new Error('A selected Page was not found for this Facebook account. Refresh the Page list and try again.');
        const id = crypto.randomUUID();
        const first = photos[0] || null;
        insert.run(id, req.session.fbUser.id, page.page_id, page.name, String(message), first ? '' : imageUrl, first ? first.buffer : null, first ? first.mime : null, publishTime, isAiContent ? 1 : 0, now(), now(), req.session.customerAccount.id);
        photos.forEach((photo,index) => insertPhoto.run(id,index,photo.buffer,photo.mime));
        created.push(id);
      }
    });
    tx();
    const placeholders = created.map(() => '?').join(',');
    // The shared scheduler processes up to 10 due jobs per pass. Repeat passes so
    // Publish Now can handle bulk selections larger than 10 Pages.
    for (let attempt = 0; attempt < Math.ceil(created.length / 10) + 2; attempt++) {
      await publishDueJobs();
      const remaining = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE id IN (" + placeholders + ") AND status='scheduled' AND scheduled_at<=?").get(...created, now()).count;
      if (!remaining) break;
    }
    const jobs = db.prepare(`SELECT id,page_id,page_name,scheduled_at,status,post_id,error,is_ai_content FROM jobs WHERE id IN (${placeholders}) ORDER BY created_at`).all(...created);
    res.status(201).json({ jobs });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.delete('/api/schedule/:id', requireTrustedOrigin, requireAuth, (req, res) => {
  const result = db.prepare("DELETE FROM jobs WHERE id=? AND customer_id=? AND user_id=? AND status='scheduled'").run(req.params.id, req.session.customerAccount.id, req.session.fbUser.id);
  if (!result.changes) return res.status(404).json({ error: 'Scheduled job not found or already started.' });
  res.json({ ok: true });
});

function describeMetaError(data, httpStatus) {
  const err = data?.error || {};
  const parts = [err.message || 'Meta rejected the photo post.'];
  if (err.type) parts.push('type ' + err.type);
  if (err.code != null) parts.push('code ' + err.code);
  if (err.error_subcode != null) parts.push('subcode ' + err.error_subcode);
  if (httpStatus) parts.push('HTTP ' + httpStatus);
  if (err.fbtrace_id) parts.push('trace ' + err.fbtrace_id);
  return parts.join(' | ').slice(0, 1400);
}

async function publishDueJobs() {
  const due = db.prepare("SELECT * FROM jobs WHERE status='scheduled' AND scheduled_at<=? ORDER BY scheduled_at LIMIT 10").all(now());
  for (const job of due) {
    const claimed = db.prepare("UPDATE jobs SET status='publishing',updated_at=? WHERE id=? AND status='scheduled'").run(now(), job.id);
    if (!claimed.changes) continue;
    try {
      const customer = db.prepare('SELECT status FROM customer_accounts WHERE id=?').get(job.customer_id);
      if (!customer || customer.status !== 'active') throw new Error('Customer account is inactive; scheduled post was not published.');
      const encryptedPage = db.prepare('SELECT access_token FROM customer_pages WHERE customer_id=? AND facebook_user_id=? AND page_id=?').get(job.customer_id, job.user_id, job.page_id);
      if (!encryptedPage?.access_token) throw new Error('Page token missing. Reconnect Facebook and refresh Pages.');
      const page = { access_token: decryptToken(encryptedPage.access_token) };
      let response;
      const storedPhotos = db.prepare('SELECT image_data,image_mime_type FROM job_images WHERE job_id=? ORDER BY position').all(job.id);
      const photos = storedPhotos.length ? storedPhotos : (job.image_data && job.image_data.length ? [{ image_data: job.image_data, image_mime_type: job.image_mime_type || 'image/jpeg' }] : []);
      if (photos.length > 1) {
        const mediaIds = [];
        for (let i = 0; i < photos.length; i++) {
          const photo = photos[i];
          const body = new FormData();
          body.set('source', new Blob([photo.image_data], { type: photo.image_mime_type || 'image/jpeg' }), photo.image_mime_type === 'image/png' ? 'upload.png' : 'upload.jpg');
          body.set('published', 'false');
          body.set('is_gen_ai', job.is_ai_content ? 'true' : 'false');
          body.set('provenance_type', job.is_ai_content ? 'EXPLICIT' : 'NONE');
          body.set('access_token', page.access_token);
          const uploadResponse = await fetch(graph(job.page_id + '/photos'), { method: 'POST', body });
          const uploadData = await uploadResponse.json().catch(() => ({}));
          if (!uploadResponse.ok || uploadData.error || !uploadData.id) throw new Error(describeMetaError(uploadData, uploadResponse.status));
          mediaIds.push(String(uploadData.id));
        }
        const feedBody = new URLSearchParams({ message: job.message || '', access_token: page.access_token });
        mediaIds.forEach((mediaId,index) => feedBody.set('attached_media[' + index + ']', JSON.stringify({ media_fbid: mediaId })));
        response = await fetch(graph(job.page_id + '/feed'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: feedBody });
      } else if (photos.length === 1) {
        const photo = photos[0];
        const body = new FormData();
        body.set('source', new Blob([photo.image_data], { type: photo.image_mime_type || 'image/jpeg' }), photo.image_mime_type === 'image/png' ? 'upload.png' : 'upload.jpg');
        body.set('caption', job.message || '');
        body.set('is_gen_ai', job.is_ai_content ? 'true' : 'false');
        body.set('provenance_type', job.is_ai_content ? 'EXPLICIT' : 'NONE');
        body.set('access_token', page.access_token);
        response = await fetch(graph(job.page_id + '/photos'), { method: 'POST', body });
      } else {
        const body = new URLSearchParams({ url: job.image_url, caption: job.message, is_gen_ai: job.is_ai_content ? 'true' : 'false', provenance_type: job.is_ai_content ? 'EXPLICIT' : 'NONE', access_token: page.access_token });
        response = await fetch(graph(job.page_id + '/photos'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) throw new Error(describeMetaError(data, response.status));
      db.prepare("UPDATE jobs SET status='published',post_id=?,error=NULL,updated_at=? WHERE id=?").run(String(data.post_id || data.id || ''), now(), job.id);
    } catch (e) {
      const message = String(e.message || e).slice(0, 1500);
      db.prepare("UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=?").run(message, now(), job.id);
      console.error('Scheduled publish failed', job.id, message);
    }
  }
}
const schedulerExpression = process.env.NODE_ENV === 'test' && process.env.TEST_SCHEDULER_CRON
  ? process.env.TEST_SCHEDULER_CRON
  : '* * * * *';
cron.schedule(schedulerExpression, () => publishDueJobs().catch(err => console.error('Scheduler loop failed:', err)));

app.get('/', (_req, res) => res.type('text').send('Facebook Bulk Scheduler Pro 3 backend is running.'));
app.listen(PORT, () => console.log(`Facebook Bulk Scheduler Pro 3 listening on ${PORT}`));
