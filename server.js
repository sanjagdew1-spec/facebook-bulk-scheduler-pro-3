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
const TRUSTED_APP_ORIGINS = new Set([FRONTEND_ORIGIN,'https://sanjagdew1-spec.github.io','https://facebook-bulk-scheduler-pro-3-p4-preview.onrender.com','https://facebook-bulk-scheduler-pro-3-p3-web.onrender.com']);
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
const PHASE5_API_URL = (process.env.PHASE5_API_URL || 'https://facebook-bulk-scheduler-pro-3-p5-api.onrender.com').replace(/\/$/, '');
const PHASE5_ACCESS_SYNC_SECRET = String(process.env.PHASE5_ACCESS_SYNC_SECRET || '').trim();

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
  if (!process.env.DB_PATH || !path.isAbsolute(DB_PATH)) missing.push('DB_PATH (absolute path)');
  if (!APP_BASE_URL) missing.push('APP_BASE_URL');
  // Phase 3 may boot in setup mode before the owner enters Meta credentials.
  // Facebook login/publishing endpoints remain unavailable until required secrets are configured.
  if (missing.length) throw new Error('Phase 3 service configuration is incomplete: ' + missing.join(', '));
  if (!META_APP_ID || !META_APP_SECRET || !process.env.SESSION_SECRET || !isTokenEncryptionConfigured()) {
    console.warn('[setup-mode] Meta app credentials, session secret, or token encryption key are not configured; Facebook actions are not ready.');
  }
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
  const allowedOrigins = TRUSTED_APP_ORIGINS;
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

registerCustomerAuthRoutes(app, { db, trustedOrigins: TRUSTED_APP_ORIGINS });

const graph = (path) => `${GRAPH_BASE_URL}/${path}`;
const now = () => new Date().toISOString();
const scopes = ['public_profile', 'pages_show_list', 'pages_manage_posts', 'pages_read_engagement'];

const TRUSTED_ORIGINS = TRUSTED_APP_ORIGINS;
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
  appIdPresent: Boolean(META_APP_ID), appId: META_APP_ID || null,
  appSecretPresent: Boolean(META_APP_SECRET), appIdLength: META_APP_ID.length, appSecretLength: META_APP_SECRET.length,
  loginConfigIdPresent: Boolean(META_LOGIN_CONFIG_ID), loginConfigIdSuffix: META_LOGIN_CONFIG_ID ? META_LOGIN_CONFIG_ID.slice(-4) : null,
  appIdHasOuterWhitespace: META_APP_ID_RAW !== META_APP_ID,
  appSecretHasOuterWhitespace: META_APP_SECRET_RAW !== META_APP_SECRET,
  tokenEncryptionConfigured: isTokenEncryptionConfigured(),
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
  // Return to the exact trusted frontend that started Facebook login, rather than
  // sending every Phase 3/4 user to the single global FRONTEND_SUCCESS_URL.
  let oauthReturnUrl = null;
  try {
    const candidate = new URL(String(req.query.return_to || ''));
    if (candidate.protocol === 'https:' && TRUSTED_APP_ORIGINS.has(candidate.origin)) {
      oauthReturnUrl = candidate.toString();
    }
  } catch {}
  req.session.oauthReturnUrl = oauthReturnUrl;
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
    // Prefer the trusted frontend URL that initiated login. This keeps Phase 4 users
    // on the new scheduler instead of redirecting them to the older global Phase 3 URL.
    const savedReturnUrl = req.session.oauthReturnUrl;
    delete req.session.oauthReturnUrl;
    const successUrl = savedReturnUrl ? new URL(savedReturnUrl) : new URL(FRONTEND_SUCCESS_URL);
    if (!savedReturnUrl && !successUrl.searchParams.has('open')) successUrl.searchParams.set('open', 'software');
    successUrl.searchParams.set('facebook_connected', '1');
    res.redirect(successUrl.toString());

 } catch (e) {
    res.status(400).send(`Facebook connection failed: ${String(e.message || e)}. Check Meta app status, OAuth redirect URI, and permission access.`);
  }
});

app.get('/auth/status', (req, res) => {
  const connectedUser = req.session.customerAccount?.id && req.session.fbUser?.customerId === req.session.customerAccount.id ? req.session.fbUser : null;
  res.json({ connected: Boolean(connectedUser), user: connectedUser ? { id: connectedUser.id, name: connectedUser.name } : null });
});
app.post('/auth/logout', requireTrustedOrigin, (req, res) => req.session.destroy(err => err ? res.status(500).json({ error: 'Could not log out.' }) : res.json({ ok: true })));

function requireCustomerSession(req, res, next) {
  const customerId = req.session.customerAccount?.id;
  if (!customerId) return res.status(401).json({ error: 'Sign in to your customer account first.' });
  const customer = db.prepare('SELECT id,email_normalized,status FROM customer_accounts WHERE id=?').get(customerId);
  if (!customer || customer.status !== 'active') {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'This customer account is not active. Sign in again or contact support.' });
  }
  req.customerAccount = customer;
  next();
}
async function getPhase5Access(email) {
  if (!PHASE5_ACCESS_SYNC_SECRET) throw new Error('Plan access integration is not configured.');
  const response = await fetch(PHASE5_API_URL + '/internal/access-check', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-phase5-access-secret': PHASE5_ACCESS_SYNC_SECRET }, body: JSON.stringify({ email }) });
  if (!response.ok) throw new Error('Plan access service is unavailable.');
  const data = await response.json();
  if (!data || !data.access) throw new Error('Plan access service returned an invalid response.');
  return data.access;
}
async function requirePlanAccess(req, res, next) {
  try {
    const email = req.customerAccount?.email_normalized || db.prepare('SELECT email_normalized FROM customer_accounts WHERE id=?').get(req.session.customerAccount.id)?.email_normalized;
    if (!email) return res.status(401).json({ error: 'Customer account was not found. Sign in again.' });
    const access = await getPhase5Access(email);
    if (!access.allowed) return res.status(403).json({ error: access.message || 'No active plan is assigned to this account.' });
    req.planAccess = access;
    next();
  } catch (error) {
    console.error('[plan-access] Check failed:', String(error?.message || error));
    return res.status(503).json({ error: 'Could not verify your plan right now. Please retry in a moment.' });
  }
}
function enforcePlanLimits(req, res, { batchCount = 1, targetCount = 0, pageIds = [], scheduledDates = [] } = {}) {
  const access = req.planAccess;
  if (!access || access.unlimited || access.role === 'developer') return true;
  const limits = access.limits || {}, customerId = req.session.customerAccount.id;
  const uniquePages = [...new Set(pageIds.map(String))];
  if (Number.isFinite(Number(limits.pages)) && uniquePages.length > Number(limits.pages)) { res.status(403).json({ error: 'Your ' + access.planName + ' plan allows up to ' + limits.pages + ' Pages in one workflow.' }); return false; }
  // Accept the canonical API field and legacy snake_case aliases, but never silently
  // skip batch enforcement for a paid/limited plan when the field is missing.
  const batchLimitValue = limits.slotsPerBatch ?? limits.slots_per_batch ?? limits.batchLimit ?? limits.postsPerBatch;
  const batchLimit = Number(batchLimitValue);
  if (!Number.isFinite(batchLimit) || batchLimit < 1) {
    res.status(503).json({ error: 'Your plan batch limit could not be verified. Please retry shortly or contact support.' });
    return false;
  }
  if (batchCount > batchLimit) { res.status(403).json({ error: 'Your ' + access.planName + ' plan allows up to ' + batchLimit + ' separate posts per batch. Reduce this batch and try again.' }); return false; }
  const startsAt = access.startsAt ? new Date(access.startsAt).toISOString() : '1970-01-01T00:00:00.000Z';
  const activeStatuses = "('scheduled','publishing','published')";
  const totalLimit = Number(limits.totalPosts);
  if (Number.isFinite(totalLimit)) {
    const reservedTotal = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE customer_id=? AND created_at>=? AND status IN " + activeStatuses).get(customerId, startsAt).count;
    if (reservedTotal + targetCount > totalLimit) { res.status(403).json({ error: 'Your ' + access.planName + ' plan allows ' + totalLimit + ' total posts. ' + reservedTotal + ' posts are already scheduled or published in this plan period.' }); return false; }
  }
  const windowDays = Number(limits.scheduleWindowDays || 0), expiry = access.endsAt ? Date.parse(access.endsAt) : Infinity;
  const dates = scheduledDates.length ? scheduledDates : Array.from({ length: targetCount }, () => new Date());
  const dayCounts = new Map();
  for (const value of dates) {
    const time = value instanceof Date ? value.getTime() : Date.parse(value);
    if (!Number.isFinite(time)) { res.status(400).json({ error: 'One or more schedule times are invalid.' }); return false; }
    if (time < Date.now() - 60000 || time > expiry) { res.status(403).json({ error: 'Your ' + access.planName + ' plan does not allow publishing beyond its active subscription period.' }); return false; }
    const day = new Date(time); day.setUTCHours(0,0,0,0);
    const tomorrow = new Date(day.getTime()+86400000).getTime();
    if ((windowDays <= 0 && time >= tomorrow) || (windowDays > 0 && time > Date.now() + windowDays * 86400000)) { res.status(403).json({ error: 'Your ' + access.planName + ' plan does not allow scheduling that far ahead.' }); return false; }
    const key = day.toISOString();
    dayCounts.set(key, (dayCounts.get(key) || 0) + 1);
  }
  const dailyLimit = Number(limits.postsPerDay);
  if (Number.isFinite(dailyLimit)) for (const [dayStart, requestedForDay] of dayCounts) {
    const dayEnd = new Date(Date.parse(dayStart) + 86400000).toISOString();
    const used = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE customer_id=? AND scheduled_at>=? AND scheduled_at<? AND status IN " + activeStatuses).get(customerId, dayStart, dayEnd).count;
    if (used + requestedForDay > dailyLimit) { res.status(403).json({ error: 'Your ' + access.planName + ' plan allows ' + dailyLimit + ' posts per day. ' + used + ' posts are already scheduled or published for ' + dayStart.slice(0,10) + '.' }); return false; }
  }
  return true;
}
app.get('/api/usage', requireCustomerSession, async (req, res) => {
  try {
    const access = await getPhase5Access(req.customerAccount.email_normalized);
    if (!access || !access.allowed) return res.status(403).setHeader('Cache-Control','no-store').json({ error: access?.message || 'No active plan.' });
    if (access.unlimited || access.role === 'developer') return res.setHeader('Cache-Control','no-store').json({ unlimited: true, used: 0, limit: null, remaining: null });
    const start = new Date(); start.setUTCHours(0,0,0,0);
    const end = new Date(start.getTime()+86400000).toISOString();
    const used = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE customer_id=? AND scheduled_at>=? AND scheduled_at<? AND status IN ('scheduled','publishing','published')").get(req.customerAccount.id, start.toISOString(), end).count;
    const totalStart = access.startsAt ? new Date(access.startsAt).toISOString() : '1970-01-01T00:00:00.000Z';
    const totalUsed = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE customer_id=? AND created_at>=? AND status IN ('scheduled','publishing','published')").get(req.customerAccount.id, totalStart).count;
    const limit = Number(access.limits?.postsPerDay), totalLimit = Number(access.limits?.totalPosts);
    return res.setHeader('Cache-Control','no-store').json({ unlimited: false, used, limit, remaining: Math.max(0, limit - used), totalUsed, totalLimit, totalRemaining: Math.max(0,totalLimit-totalUsed), date: start.toISOString().slice(0,10) });
  } catch (error) {
    console.error('[post-usage] Status check failed:', String(error?.message || error));
    return res.status(503).setHeader('Cache-Control','no-store').json({ error: 'Could not refresh post usage.' });
  }
});

app.get('/api/access', requireCustomerSession, async (req, res) => {
  try { return res.setHeader('Cache-Control','no-store').json(await getPhase5Access(req.customerAccount.email_normalized)); }
  catch (error) { console.error('[plan-access] Status check failed:', String(error?.message || error)); return res.status(503).json({ error: 'Could not refresh plan status. Please retry.' }); }
});
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

app.get('/api/pages', requireAuth, requirePlanAccess, async (req, res) => {
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

app.post('/api/history/clear', requireTrustedOrigin, requireAuth, (req, res) => {
  // Clear only terminal app-history rows; never delete scheduled jobs or Facebook posts.
  const result = db.prepare("DELETE FROM jobs WHERE customer_id=? AND user_id=? AND status IN ('published','failed')").run(req.session.customerAccount.id, req.session.fbUser.id);
  res.json({ ok: true, cleared: result.changes, note: 'Only published/failed app history records were cleared. Facebook posts were not deleted.' });
});

app.post('/api/bulk-photos', requireTrustedOrigin, requireAuth, requirePlanAccess, async (req, res) => {
  const { pageId: defaultPageId, posts, mode = 'now' } = req.body || {};
  if (!Array.isArray(posts) || posts.length < 1 || posts.length > 100) return res.status(400).json({ error: 'A photo batch must contain between 1 and 100 separate posts.' });
  const accessLimits = req.planAccess?.limits || {};
  const configuredBatchLimit = Number(accessLimits.slotsPerBatch ?? accessLimits.slots_per_batch ?? accessLimits.batchLimit ?? accessLimits.postsPerBatch);
  console.info('[batch-limit-check]', JSON.stringify({ role: req.planAccess?.role || null, planName: req.planAccess?.planName || null, postsInRequest: posts.length, configuredBatchLimit: Number.isFinite(configuredBatchLimit) ? configuredBatchLimit : null, unlimited: Boolean(req.planAccess?.unlimited) }));
  if (req.planAccess && !req.planAccess.unlimited && req.planAccess.role !== 'developer') {
    if (!Number.isInteger(configuredBatchLimit) || configuredBatchLimit < 1) return res.status(503).json({ error: 'Your plan batch limit could not be verified. Please retry shortly or contact support.' });
    if (posts.length > configuredBatchLimit) return res.status(403).json({ error: 'Your ' + (req.planAccess.planName || 'current') + ' plan allows up to ' + configuredBatchLimit + ' separate posts per batch. You selected ' + posts.length + '. Split this into smaller batches and try again.' });
  }
  if (!['now','schedule'].includes(mode)) return res.status(400).json({ error: 'Choose publish now or schedule.' });
  const batchPageIds=[], scheduledBatchDates=[]; let batchTargetCount=0;
  for (const item of posts) { const ids=Array.isArray(item?.pageSchedules)&&item.pageSchedules.length?item.pageSchedules.map(t=>t?.pageId):Array.isArray(item?.pageIds)&&item.pageIds.length?item.pageIds:(item?.pageId!=null?[item.pageId]:(defaultPageId!=null?[defaultPageId]:[])); batchPageIds.push(...ids.filter(x=>x!=null)); batchTargetCount+=ids.filter(x=>x!=null).length; if(mode==='schedule'){if(Array.isArray(item?.pageSchedules)&&item.pageSchedules.length)scheduledBatchDates.push(...item.pageSchedules.map(t=>t?.scheduledAt||item.scheduledAt).filter(Boolean));else if(item?.scheduledAt)scheduledBatchDates.push(item.scheduledAt);} }
  if (!enforcePlanLimits(req,res,{batchCount:posts.length,targetCount:batchTargetCount,pageIds:batchPageIds,scheduledDates:scheduledBatchDates})) return;
  const prepared = [];
  for (let index = 0; index < posts.length; index++) {
    const item = posts[index] || {};
    if (!Array.isArray(item.images) || item.images.length < 1 || item.images.length > 10) return res.status(400).json({ error: 'Post ' + (index + 1) + ' must contain 1 to 10 images.' });
    let bytes = 0;
    const photos = [];
    for (const photo of item.images) {
      const match = typeof photo?.imageData === 'string' ? photo.imageData.match(/^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/) : null;
      if (!match) return res.status(400).json({ error: 'Post ' + (index + 1) + ' contains an invalid JPG/PNG image.' });
      const buffer = Buffer.from(match[2], 'base64');
      if (!buffer.length || buffer.length > 6 * 1024 * 1024) return res.status(400).json({ error: 'Each image must be 6 MB or smaller.' });
      if (photo.imageMimeType && photo.imageMimeType !== match[1]) return res.status(400).json({ error: 'Image type mismatch in post ' + (index + 1) + '.' });
      bytes += buffer.length;
      photos.push({ buffer, mime: match[1] });
    }
    if (bytes > 30 * 1024 * 1024) return res.status(400).json({ error: 'Images in each post must total 30 MB or less.' });

    let requestedTargets = [];
    if (Array.isArray(item.pageSchedules) && item.pageSchedules.length) {
      requestedTargets = item.pageSchedules.map(target => ({ pageId: target?.pageId, scheduledAt: target?.scheduledAt || item.scheduledAt }));
    } else {
      const ids = Array.isArray(item.pageIds) && item.pageIds.length ? item.pageIds : (item.pageId != null ? [item.pageId] : (defaultPageId != null ? [defaultPageId] : []));
      requestedTargets = ids.map(pageId => ({ pageId, scheduledAt: item.scheduledAt }));
    }
    if (!requestedTargets.length || requestedTargets.some(target => (typeof target.pageId !== 'string' && typeof target.pageId !== 'number'))) {
      return res.status(400).json({ error: 'Post ' + (index + 1) + ' must have at least one selected Page.' });
    }
    const seen = new Set();
    const targets = [];
    for (const target of requestedTargets) {
      const id = String(target.pageId);
      if (seen.has(id)) return res.status(400).json({ error: 'Post ' + (index + 1) + ' selects the same Page more than once.' });
      seen.add(id);
      const page = db.prepare('SELECT page_id,name FROM customer_pages WHERE customer_id=? AND facebook_user_id=? AND page_id=?').get(req.session.customerAccount.id, req.session.fbUser.id, id);
      if (!page) return res.status(400).json({ error: 'A selected Page for post ' + (index + 1) + ' was not found for this Facebook account. Refresh Pages and try again.' });
      let scheduledAt = now();
      if (mode === 'schedule') {
        const date = new Date(target.scheduledAt);
        if (!target.scheduledAt || Number.isNaN(date.getTime()) || date.getTime() < Date.now() + 15000) {
          return res.status(400).json({ error: 'Set a valid future time for every selected Page on post ' + (index + 1) + ' (at least 15 seconds ahead).' });
        }
        scheduledAt = date.toISOString();
      }
      targets.push({ pageId: String(page.page_id), pageName: page.name, scheduledAt });
    }
    prepared.push({ message: String(item.message || ''), photos, targets, isAiContent: Boolean(item.isAiContent) });
  }
  const insert = db.prepare("INSERT INTO jobs(id,user_id,page_id,page_name,message,image_url,image_data,image_mime_type,scheduled_at,status,is_ai_content,created_at,updated_at,customer_id) VALUES(?,?,?,?,?,'',?,?,?,'scheduled',?,?,?,?)");
  const insertPhoto = db.prepare('INSERT INTO job_images(job_id,position,image_data,image_mime_type) VALUES(?,?,?,?)');
  const created = [];
  try {
    const tx = db.transaction(() => {
      for (const item of prepared) {
        for (const target of item.targets) {
          const id = crypto.randomUUID();
          const first = item.photos[0];
          insert.run(id, req.session.fbUser.id, target.pageId, target.pageName, item.message, first.buffer, first.mime, target.scheduledAt, item.isAiContent ? 1 : 0, now(), now(), req.session.customerAccount.id);
          item.photos.forEach((photo, position) => insertPhoto.run(id, position, photo.buffer, photo.mime));
          created.push(id);
        }
      }
    });
    tx();
    if (mode === 'now') {
      for (let attempt = 0; attempt < Math.ceil(created.length / 10) + 2; attempt++) {
        await publishDueJobs();
        const remaining = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE id IN (" + created.map(() => '?').join(',') + ") AND status IN ('scheduled','publishing') AND scheduled_at<=?").get(...created, now()).count;
        if (!remaining) break;
      }
    }
    const rows = db.prepare("SELECT id,page_id,page_name,message,scheduled_at,status,post_id,error,is_ai_content,created_at,updated_at FROM jobs WHERE id IN (" + created.map(() => '?').join(',') + ") ORDER BY scheduled_at,created_at").all(...created);
    res.status(201).json({ jobs: rows, requestedCount: prepared.reduce((sum, item) => sum + item.targets.length, 0), createdCount: rows.length });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});


/* Private Owner Security & Content Review bridge. Never expose this data to customer-facing routes. */
function securityBridgeAuthorized(req) {
  const expected = String(PHASE5_ACCESS_SYNC_SECRET || '');
  const provided = String(req.headers['x-phase5-access-secret'] || '');
  if (!expected || !provided) return false;
  const a = Buffer.from(expected), b = Buffer.from(provided);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
app.get('/internal/security/customer', (req, res) => {
  if (!securityBridgeAuthorized(req)) return res.status(401).json({ error: 'Owner security bridge not authorized.' });
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email.endsWith('@gmail.com') || email.indexOf('@') <= 0 || email.includes(' ')) return res.status(400).json({ error: 'Enter a valid customer Gmail.' });
  const customer = db.prepare('SELECT id,email_normalized,username,status,created_at FROM customer_accounts WHERE email_normalized=?').get(email);
  if (!customer) return res.status(404).json({ error: 'No scheduler account was found for this email.' });
  const jobs = db.prepare("SELECT id,page_name,message,scheduled_at,status,created_at,image_data,image_mime_type FROM jobs WHERE status='scheduled' AND (customer_id=? OR (customer_id IS NULL AND user_id IN (SELECT facebook_user_id FROM customer_facebook_connections WHERE customer_id=?))) ORDER BY scheduled_at ASC").all(customer.id, customer.id);
  const getImages = db.prepare('SELECT position,image_data,image_mime_type FROM job_images WHERE job_id=? ORDER BY position ASC');
  const result = jobs.map(job => {
    const images = getImages.all(job.id).map(photo => ({ position: photo.position + 1, mimeType: photo.image_mime_type, dataBase64: Buffer.from(photo.image_data).toString('base64') }));
    if (!images.length && job.image_data) images.push({ position: 1, mimeType: job.image_mime_type || 'image/jpeg', dataBase64: Buffer.from(job.image_data).toString('base64') });
    return { id: job.id, pageName: job.page_name, caption: job.message || '', scheduledAt: job.scheduled_at, status: job.status, createdAt: job.created_at, images };
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ customer: { id: customer.id, email: customer.email_normalized, username: customer.username || '', status: customer.status, createdAt: customer.created_at }, scheduledPostCount: result.length, photoCount: result.reduce((n, job) => n + job.images.length, 0), jobs: result });
});
app.post('/internal/security/remove-customer', (req, res) => {
  if (!securityBridgeAuthorized(req)) return res.status(401).json({ error: 'Owner security bridge not authorized.' });
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email.endsWith('@gmail.com') || email.indexOf('@') <= 0 || email.includes(' ')) return res.status(400).json({ error: 'Enter a valid customer Gmail.' });
  const customer = db.prepare('SELECT id,email_normalized FROM customer_accounts WHERE email_normalized=?').get(email);
  if (!customer) return res.status(404).json({ error: 'No scheduler account was found for this email.' });
  const removeAccount = db.transaction(() => {
    const scheduledIds = db.prepare("SELECT id FROM jobs WHERE status IN ('scheduled','publishing') AND (customer_id=? OR (customer_id IS NULL AND user_id IN (SELECT facebook_user_id FROM customer_facebook_connections WHERE customer_id=?)))").all(customer.id, customer.id).map(row => row.id);
    if (scheduledIds.length) {
      const marks = scheduledIds.map(() => '?').join(',');
      db.prepare('DELETE FROM job_images WHERE job_id IN (' + marks + ')').run(...scheduledIds);
      db.prepare('DELETE FROM jobs WHERE id IN (' + marks + ')').run(...scheduledIds);
    }
    db.prepare('DELETE FROM customer_facebook_connections WHERE customer_id=?').run(customer.id);
    db.prepare('DELETE FROM customer_pages WHERE customer_id=?').run(customer.id);
    db.prepare('DELETE FROM pages WHERE customer_id=?').run(customer.id);
    db.prepare('DELETE FROM customer_accounts WHERE id=?').run(customer.id);
    return scheduledIds.length;
  });
  const deletedScheduledPosts = removeAccount();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, email: customer.email_normalized, deletedScheduledPosts, accountRemoved: true, refund: false });
});

app.get('/api/jobs', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id,page_id,page_name,message,image_url,scheduled_at,status,post_id,error,is_ai_content,created_at,updated_at FROM jobs WHERE customer_id=? AND user_id=? ORDER BY scheduled_at DESC LIMIT 500').all(req.session.customerAccount.id, req.session.fbUser.id);
  res.json({ jobs: rows });
});

app.post('/api/schedule', requireTrustedOrigin, requireAuth, requirePlanAccess, (req, res) => {
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
  if (!enforcePlanLimits(req,res,{targetCount:validatedSchedules.length,pageIds:validatedSchedules.map(item=>item.pageId),scheduledDates:validatedSchedules.map(item=>item.date)})) return;
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

app.post('/api/publish-now', requireTrustedOrigin, requireAuth, requirePlanAccess, async (req, res) => {
  const { pageIds, imageUrl = '', images: incomingImages = [], message = '', isAiContent = false } = req.body || {};
  if (!Array.isArray(pageIds) || !pageIds.length) return res.status(400).json({ error: 'Select at least one Page.' });
  const ids = pageIds.map(String);
  if (new Set(ids).size !== ids.length) return res.status(400).json({ error: 'A Page was selected more than once. Refresh the Page list and try again.' });
  if (!enforcePlanLimits(req,res,{targetCount:ids.length,pageIds:ids})) return;
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
      const customer = db.prepare('SELECT status,email_normalized FROM customer_accounts WHERE id=?').get(job.customer_id);
      if (!customer || customer.status !== 'active') throw new Error('Customer account is inactive; scheduled post was not published.');
      let currentAccess;
      try { currentAccess = await getPhase5Access(customer.email_normalized); } catch { const retryError = new Error('Plan access service is temporarily unavailable; this scheduled post will retry.'); retryError.code = 'ACCESS_SERVICE_UNAVAILABLE'; throw retryError; }
      if (!currentAccess.allowed) throw new Error('Plan access has expired or was removed; this scheduled post was not published.');
      if (!currentAccess.unlimited && currentAccess.endsAt && Date.parse(job.scheduled_at) > Date.parse(currentAccess.endsAt)) throw new Error('Scheduled time is beyond the active plan expiry; post was not published.');
      if (!currentAccess.unlimited && currentAccess.role !== 'developer') {
        const planStart = currentAccess.startsAt ? new Date(currentAccess.startsAt).toISOString() : '1970-01-01T00:00:00.000Z';
        const totalLimit = Number(currentAccess.limits?.totalPosts), dailyLimit = Number(currentAccess.limits?.postsPerDay);
        if (Number.isFinite(totalLimit)) {
          const totalPublished = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE customer_id=? AND created_at>=? AND status='published'").get(job.customer_id, planStart).count;
          if (totalPublished >= totalLimit) throw new Error('Total post allowance reached; this scheduled post was not published.');
        }
        if (Number.isFinite(dailyLimit)) {
          const dayStart = new Date(job.scheduled_at); dayStart.setUTCHours(0,0,0,0);
          const dayEnd = new Date(dayStart.getTime()+86400000).toISOString();
          const dailyPublished = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE customer_id=? AND scheduled_at>=? AND scheduled_at<? AND status='published'").get(job.customer_id, dayStart.toISOString(), dayEnd).count;
          if (dailyPublished >= dailyLimit) throw new Error('Daily post allowance reached; this scheduled post was not published.');
        }
      }
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
          body.set('created_with_ai', job.is_ai_content ? 'true' : 'false');
          body.set('edited_with_ai', 'false');
          body.set('provenance_type', job.is_ai_content ? 'EXPLICIT' : 'NONE');
          body.set('access_token', page.access_token);
          const uploadResponse = await fetch(graph(job.page_id + '/photos'), { method: 'POST', body });
          const uploadData = await uploadResponse.json().catch(() => ({}));
          if (!uploadResponse.ok || uploadData.error || !uploadData.id) throw new Error(describeMetaError(uploadData, uploadResponse.status));
          mediaIds.push(String(uploadData.id));
        }
        const feedBody = new URLSearchParams({ message: job.message || '', access_token: page.access_token, is_gen_ai: job.is_ai_content ? 'true' : 'false', created_with_ai: job.is_ai_content ? 'true' : 'false', edited_with_ai: 'false', provenance_type: job.is_ai_content ? 'EXPLICIT' : 'NONE' });
        mediaIds.forEach((mediaId,index) => feedBody.set('attached_media[' + index + ']', JSON.stringify({ media_fbid: mediaId })));
        response = await fetch(graph(job.page_id + '/feed'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: feedBody });
      } else if (photos.length === 1) {
        const photo = photos[0];
        const body = new FormData();
        body.set('source', new Blob([photo.image_data], { type: photo.image_mime_type || 'image/jpeg' }), photo.image_mime_type === 'image/png' ? 'upload.png' : 'upload.jpg');
        body.set('caption', job.message || '');
        body.set('is_gen_ai', job.is_ai_content ? 'true' : 'false');
        body.set('created_with_ai', job.is_ai_content ? 'true' : 'false');
        body.set('edited_with_ai', 'false');
        body.set('provenance_type', job.is_ai_content ? 'EXPLICIT' : 'NONE');
        body.set('access_token', page.access_token);
        response = await fetch(graph(job.page_id + '/photos'), { method: 'POST', body });
      } else {
        const body = new URLSearchParams({ url: job.image_url, caption: job.message, is_gen_ai: job.is_ai_content ? 'true' : 'false', created_with_ai: job.is_ai_content ? 'true' : 'false', edited_with_ai: 'false', provenance_type: job.is_ai_content ? 'EXPLICIT' : 'NONE', access_token: page.access_token });
        response = await fetch(graph(job.page_id + '/photos'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) throw new Error(describeMetaError(data, response.status));
      db.prepare("UPDATE jobs SET status='published',post_id=?,error=NULL,updated_at=? WHERE id=?").run(String(data.post_id || data.id || ''), now(), job.id);
    } catch (e) {
      const message = String(e.message || e).slice(0, 1500);
      if (e?.code === 'ACCESS_SERVICE_UNAVAILABLE') {
        db.prepare("UPDATE jobs SET status='scheduled',error=?,updated_at=? WHERE id=?").run(message, now(), job.id);
        console.warn('Scheduled publish deferred', job.id, message);
        continue;
      }
      db.prepare("UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=?").run(message, now(), job.id);
      console.error('Scheduled publish failed', job.id, message);
    }
  }
}
const schedulerExpression = process.env.NODE_ENV === 'test' && process.env.TEST_SCHEDULER_CRON
  ? process.env.TEST_SCHEDULER_CRON
  : '*/15 * * * * *';
// Run a bounded queue pass every 15 seconds, but never overlap scheduler passes.
// Each pass still processes at most 10 jobs sequentially to protect the 512 MiB instance.
let schedulerPassRunning = false;
async function runScheduledPass() {
  if (schedulerPassRunning) return;
  schedulerPassRunning = true;
  try { await publishDueJobs(); }
  catch (err) { console.error('Scheduler loop failed:', err); }
  finally { schedulerPassRunning = false; }
}
cron.schedule(schedulerExpression, () => { void runScheduledPass(); });

app.get('/', (_req, res) => res.type('text').send('Facebook Bulk Scheduler Pro 3 backend is running.'));
app.listen(PORT, () => console.log(`Facebook Bulk Scheduler Pro 3 listening on ${PORT}`));

// Deployment checkpoint: daily and total plan limits are enforced server-side.
