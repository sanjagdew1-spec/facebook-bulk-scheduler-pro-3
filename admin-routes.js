import crypto from 'node:crypto';

const PLAN_SEEDS = [
  { key: 'free_demo', name: 'Free Demo', duration_days: 7, page_limit: 10, daily_post_limit: 10, schedule_window_days: 0, slots_per_batch: 10, price_inr: 0 },
  { key: 'starter', name: 'Starter / Standard', duration_days: 28, page_limit: 10, daily_post_limit: 50, schedule_window_days: 1, slots_per_batch: 10, price_inr: 299 },
  { key: 'pro', name: 'Pro', duration_days: 28, page_limit: 25, daily_post_limit: 100, schedule_window_days: 3, slots_per_batch: 50, price_inr: 699 },
  { key: 'business', name: 'Business', duration_days: 28, page_limit: 50, daily_post_limit: 200, schedule_window_days: 7, slots_per_batch: 100, price_inr: 1499 }
];

const isoNow = () => new Date().toISOString();
const cleanEmail = value => String(value || '').trim().toLowerCase();
const positiveInt = (value, max = 3650) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= max ? number : null;
};
const nullableLimit = value => {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 1_000_000 ? n : undefined;
};

export function registerOwnerAdminRoutes(app, { db, trustedOrigins }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS plan_catalog (
      plan_key TEXT PRIMARY KEY, name TEXT NOT NULL, duration_days INTEGER NOT NULL DEFAULT 30,
      page_limit INTEGER, daily_post_limit INTEGER, schedule_window_days INTEGER, slots_per_batch INTEGER, price_inr INTEGER,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS customer_entitlements (
      customer_id TEXT PRIMARY KEY, plan_key TEXT NOT NULL, starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      source TEXT NOT NULL DEFAULT 'admin', updated_by TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES customer_accounts(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS creator_sponsorships (
      id TEXT PRIMARY KEY, creator_email TEXT NOT NULL, creator_name TEXT NOT NULL DEFAULT '',
      plan_key TEXT NOT NULL, duration_days INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
      starts_at TEXT, ends_at TEXT, assigned_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS creator_sponsorship_email_idx ON creator_sponsorships(creator_email);
    CREATE TABLE IF NOT EXISTS developer_entitlements (
      id TEXT PRIMARY KEY, subject_id TEXT NOT NULL UNIQUE, subject_type TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
      unlimited INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL,
      target_id TEXT NOT NULL DEFAULT '', details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
    );
  `);
  try { db.exec('ALTER TABLE customer_accounts ADD COLUMN email_verified_at TEXT'); }
  catch (error) { if (!String(error.message || error).includes('duplicate column name')) throw error; }

  const insertPlan = db.prepare(`INSERT OR IGNORE INTO plan_catalog(plan_key,name,duration_days,page_limit,daily_post_limit,schedule_window_days,slots_per_batch,price_inr,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`);
  for (const plan of PLAN_SEEDS) insertPlan.run(plan.key, plan.name, plan.duration_days, plan.page_limit, plan.daily_post_limit, plan.schedule_window_days, plan.slots_per_batch, plan.price_inr, isoNow());
  // Update default templates only; already-purchased customer entitlements keep their saved end dates and limits.
  db.prepare("UPDATE plan_catalog SET duration_days=28,updated_at=? WHERE plan_key IN ('starter','pro','business') AND duration_days<>28").run(isoNow());
  db.prepare("UPDATE plan_catalog SET slots_per_batch=50,updated_at=? WHERE plan_key='pro' AND slots_per_batch<>50").run(isoNow());
  db.prepare("UPDATE plan_catalog SET slots_per_batch=100,updated_at=? WHERE plan_key='business' AND slots_per_batch<>100").run(isoNow());

  const adminEmails = new Set(String(process.env.OWNER_ADMIN_EMAILS || '').split(',').map(cleanEmail).filter(Boolean));
  const adminIds = new Set(String(process.env.OWNER_ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
  const ownerIds = new Set(String(process.env.OWNER_USER_IDS || process.env.OWNER_ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
  const ownerEmails = new Set(String(process.env.OWNER_USER_EMAILS || process.env.OWNER_ADMIN_EMAILS || '').split(',').map(cleanEmail).filter(Boolean));

  function requireSameOrigin(req, res, next) {
    const origin = req.headers.origin;
    if (!origin || (!trustedOrigins.has(origin) && origin !== process.env.APP_BASE_URL)) {
      return res.status(403).json({ error: 'Request origin could not be verified.' });
    }
    next();
  }
  function requireAdmin(req, res, next) {
    const sessionUser = req.session?.customerAccount;
    if (!sessionUser?.id) return res.status(401).json({ error: 'Sign in with the owner account to continue.' });
    const account = db.prepare('SELECT id,email_normalized,username,status,email_verified_at FROM customer_accounts WHERE id=?').get(sessionUser.id);
    if (!account || account.status !== 'active') return res.status(401).json({ error: 'Owner session is not active. Sign in again.' });
    if (!adminIds.has(account.id) && !adminEmails.has(cleanEmail(account.email_normalized))) {
      return res.status(403).json({ error: 'This account is not authorized for the private Owner/Admin Control Panel.' });
    }
    req.ownerAdmin = { id: account.id, email: account.email_normalized, username: account.username };
    next();
  }
  function audit(actor, action, target, details = {}) {
    db.prepare('INSERT INTO admin_audit_log(id,actor_id,action,target_id,details_json,created_at) VALUES(?,?,?,?,?,?)')
      .run(crypto.randomUUID(), actor.id, action, String(target || ''), JSON.stringify(details), isoNow());
  }
  function plans() {
    return db.prepare('SELECT plan_key AS key,name,duration_days,page_limit,daily_post_limit,schedule_window_days,slots_per_batch,price_inr,updated_at FROM plan_catalog ORDER BY CASE plan_key WHEN \'free_demo\' THEN 1 WHEN \'starter\' THEN 2 WHEN \'pro\' THEN 3 WHEN \'business\' THEN 4 ELSE 5 END').all();
  }
  function assignPlan(customerId, planKey, durationDays, actor, source = 'admin') {
    const plan = db.prepare('SELECT * FROM plan_catalog WHERE plan_key=?').get(planKey);
    if (!plan) throw new Error('Choose a valid plan.');
    const days = positiveInt(durationDays, 3650) || plan.duration_days;
    const account = db.prepare('SELECT id FROM customer_accounts WHERE id=?').get(customerId);
    if (!account) throw new Error('Customer ID was not found.');
    const start = new Date();
    const end = new Date(start.getTime() + days * 86400000);
    const startsAt = start.toISOString(), endsAt = end.toISOString(), timestamp = isoNow();
    db.prepare(`INSERT INTO customer_entitlements(customer_id,plan_key,starts_at,ends_at,status,source,updated_by,updated_at)
      VALUES(?,?,?,?,'active',?,?,?)
      ON CONFLICT(customer_id) DO UPDATE SET plan_key=excluded.plan_key,starts_at=excluded.starts_at,ends_at=excluded.ends_at,status='active',source=excluded.source,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .run(customerId, planKey, startsAt, endsAt, source, actor.id, timestamp);
    return { planKey, startsAt, endsAt, durationDays: days };
  }
  function customerRows(filterPlan = '') {
    const where = filterPlan ? 'WHERE COALESCE(e.plan_key, \'free_demo\')=?' : '';
    const args = filterPlan ? [filterPlan] : [];
    return db.prepare(`
      SELECT a.id,a.username,a.email_normalized AS email,a.email_verified_at AS emailVerifiedAt,a.status AS accountStatus,
        a.created_at AS createdAt,COALESCE(e.plan_key,'free_demo') AS planKey,e.starts_at AS startsAt,e.ends_at AS endsAt,
        COALESCE(e.status,CASE WHEN a.status='active' THEN 'active' ELSE 'suspended' END) AS planStatus,
        (SELECT COUNT(*) FROM customer_pages p WHERE p.customer_id=a.id) AS connectedPages,
        (SELECT COUNT(*) FROM jobs j WHERE j.customer_id=a.id AND j.created_at >= strftime('%Y-%m-01T00:00:00Z','now')) AS monthlyJobs,
        (SELECT COUNT(*) FROM jobs j WHERE j.customer_id=a.id AND j.created_at >= strftime('%Y-%m-%dT00:00:00Z','now')) AS dailyJobs
      FROM customer_accounts a LEFT JOIN customer_entitlements e ON e.customer_id=a.id ${where}
      ORDER BY a.created_at DESC
    `).all(...args).map(row => ({
      ...row,
      daysRemaining: row.endsAt ? Math.max(0, Math.ceil((Date.parse(row.endsAt) - Date.now()) / 86400000)) : null,
      isOwner: ownerIds.has(row.id) || ownerEmails.has(cleanEmail(row.email)),
      emailStatus: row.emailVerifiedAt ? 'Verified' : 'Pending verification'
    }));
  }

  app.get('/api/admin/session', (req, res) => {
    const sessionUser = req.session?.customerAccount;
    if (!sessionUser?.id) return res.json({ signedIn: false, authorized: false, customer: null });
    const account = db.prepare('SELECT id,email_normalized,username,status FROM customer_accounts WHERE id=?').get(sessionUser.id);
    if (!account || account.status !== 'active') return res.json({ signedIn: false, authorized: false, customer: null });
    const authorized = adminIds.has(account.id) || adminEmails.has(cleanEmail(account.email_normalized));
    return res.json({ signedIn: true, authorized, customer: { id: account.id, email: account.email_normalized, username: account.username } });
  });
  app.get('/api/customer/entitlement', (req, res) => {
    const sessionUser = req.session?.customerAccount;
    if (!sessionUser?.id) return res.status(401).json({ error: 'Sign in to view account entitlement.' });
    const account = db.prepare("SELECT id,email_normalized,status FROM customer_accounts WHERE id=?").get(sessionUser.id);
    if (!account || account.status !== 'active') return res.status(401).json({ error: 'Customer account is not active.' });
    if (ownerIds.has(account.id) || ownerEmails.has(cleanEmail(account.email_normalized))) {
      return res.json({ unlimited: true, role: 'owner', planKey: 'owner_unlimited', status: 'active', limits: null, usage: null });
    }
    const developer = db.prepare("SELECT id FROM developer_entitlements WHERE status='active' AND unlimited=1 AND ((subject_type='customer_id' AND subject_id=?) OR (subject_type='email' AND lower(subject_id)=?))")
      .get(account.id, cleanEmail(account.email_normalized));
    if (developer) return res.json({ unlimited: true, role: 'developer', planKey: 'developer_unlimited', status: 'active', limits: null, usage: null });
    const entitlement = db.prepare(`SELECT e.plan_key,e.starts_at,e.ends_at,e.status,p.name,p.page_limit,p.daily_post_limit,p.schedule_window_days,p.slots_per_batch
      FROM customer_entitlements e LEFT JOIN plan_catalog p ON p.plan_key=e.plan_key WHERE e.customer_id=?`).get(account.id);
    if (!entitlement) return res.json({ unlimited: false, role: 'customer', planKey: 'free_demo', status: 'active', limits: { pages: null, postsPerDay: null, scheduleWindowDays: null, slotsPerBatch: null }, startsAt: null, endsAt: null, daysRemaining: null, planConfigured: false });
    const usage = {
      pages: db.prepare('SELECT COUNT(*) AS count FROM customer_pages WHERE customer_id=?').get(account.id).count,
      monthlyPosts: db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE customer_id=? AND created_at >= strftime('%Y-%m-01T00:00:00Z','now')").get(account.id).count,
      dailyPosts: db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE customer_id=? AND created_at >= strftime('%Y-%m-%dT00:00:00Z','now')").get(account.id).count
    };
    const active = entitlement.status === 'active' && Date.parse(entitlement.ends_at) > Date.now();
    return res.json({
      unlimited: false, role: 'customer', planKey: entitlement.plan_key, planName: entitlement.name || entitlement.plan_key,
      status: active ? 'active' : 'expired', startsAt: entitlement.starts_at, endsAt: entitlement.ends_at,
      daysRemaining: Math.max(0, Math.ceil((Date.parse(entitlement.ends_at) - Date.now()) / 86400000)),
      limits: { pages: entitlement.page_limit, postsPerDay: entitlement.daily_post_limit, scheduleWindowDays: entitlement.schedule_window_days, slotsPerBatch: entitlement.slots_per_batch },
      usage, planConfigured: true
    });
  });
  app.get('/api/admin/overview', requireAdmin, (_req, res) => {
    const rows = customerRows();
    res.json({
      ok: true,
      totals: {
        customers: rows.filter(r => !r.isOwner).length,
        active: rows.filter(r => !r.isOwner && r.planStatus === 'active' && (!r.endsAt || Date.parse(r.endsAt) > Date.now())).length,
        expiring: rows.filter(r => !r.isOwner && r.endsAt && Date.parse(r.endsAt) > Date.now() && Date.parse(r.endsAt) < Date.now() + 7 * 86400000).length,
        creatorsLive: db.prepare("SELECT COUNT(*) AS count FROM creator_sponsorships WHERE status='live'").get().count,
        developers: db.prepare("SELECT COUNT(*) AS count FROM developer_entitlements WHERE status='active' AND unlimited=1").get().count
      },
      plans: plans(),
      owner: { id: _req.ownerAdmin.id, email: _req.ownerAdmin.email, unlimited: true, outsideCustomerPlans: true }
    });
  });
  app.get('/api/admin/customers', requireAdmin, (req, res) => {
    const filter = String(req.query.plan || '');
    if (filter && !db.prepare('SELECT plan_key FROM plan_catalog WHERE plan_key=?').get(filter)) return res.status(400).json({ error: 'Unknown plan filter.' });
    res.json({ customers: customerRows(filter) });
  });
  app.put('/api/admin/plans/:key', requireSameOrigin, requireAdmin, (req, res) => {
    const key = String(req.params.key || '');
    const current = db.prepare('SELECT * FROM plan_catalog WHERE plan_key=?').get(key);
    if (!current) return res.status(404).json({ error: 'Plan not found.' });
    const duration = positiveInt(req.body?.durationDays, 3650);
    const pageLimit = nullableLimit(req.body?.pageLimit);
    const dailyPostLimit = nullableLimit(req.body?.dailyPostLimit);
    const scheduleWindowDays = nullableLimit(req.body?.scheduleWindowDays);
    const slots = nullableLimit(req.body?.slotsPerBatch);
    const priceInr = nullableLimit(req.body?.priceInr);
    if (!duration || pageLimit === undefined || dailyPostLimit === undefined || scheduleWindowDays === undefined || slots === undefined || priceInr === undefined) return res.status(400).json({ error: 'Enter valid non-negative plan values and a duration from 1 to 3650 days.' });
    db.prepare('UPDATE plan_catalog SET duration_days=?,page_limit=?,daily_post_limit=?,schedule_window_days=?,slots_per_batch=?,price_inr=?,updated_at=? WHERE plan_key=?')
      .run(duration, pageLimit, dailyPostLimit, scheduleWindowDays, slots, priceInr, isoNow(), key);
    audit(req.ownerAdmin, 'plan.updated', key, { duration, pageLimit, dailyPostLimit, scheduleWindowDays, slots, priceInr });
    res.json({ ok: true, plans: plans() });
  });
  app.post('/api/admin/customers/:id/plan', requireSameOrigin, requireAdmin, (req, res) => {
    try {
      const assigned = assignPlan(String(req.params.id), String(req.body?.planKey || ''), req.body?.durationDays, req.ownerAdmin);
      audit(req.ownerAdmin, 'customer.plan_assigned', req.params.id, assigned);
      res.json({ ok: true, assignment: assigned });
    } catch (error) { res.status(400).json({ error: String(error.message || error) }); }
  });
  app.get('/api/admin/creators', requireAdmin, (_req, res) => {
    res.json({ creators: db.prepare(`
      SELECT c.id,c.creator_email AS email,c.creator_name AS name,c.plan_key AS planKey,c.duration_days AS durationDays,
        c.status,c.starts_at AS startsAt,c.ends_at AS endsAt,c.created_at AS createdAt,
        a.id AS customerId
      FROM creator_sponsorships c LEFT JOIN customer_accounts a ON a.email_normalized=c.creator_email
      ORDER BY c.created_at DESC
    `).all() });
  });
  app.post('/api/admin/creators', requireSameOrigin, requireAdmin, (req, res) => {
    const email = cleanEmail(req.body?.email), name = String(req.body?.name || '').trim().slice(0,120);
    const planKey = String(req.body?.planKey || '');
    const durationDays = positiveInt(req.body?.durationDays, 3650);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid creator email.' });
    if (!db.prepare('SELECT plan_key FROM plan_catalog WHERE plan_key=?').get(planKey) || !durationDays) return res.status(400).json({ error: 'Choose a valid plan and duration.' });
    const id = crypto.randomUUID(), timestamp = isoNow();
    db.prepare('INSERT INTO creator_sponsorships(id,creator_email,creator_name,plan_key,duration_days,status,assigned_by,created_at,updated_at) VALUES(?,?,?,?,?,\'draft\',?,?,?)')
      .run(id,email,name,planKey,durationDays,req.ownerAdmin.id,timestamp,timestamp);
    audit(req.ownerAdmin, 'creator.created', id, { email, planKey, durationDays });
    res.status(201).json({ ok: true, creator: { id,email,name,planKey,durationDays,status:'draft' } });
  });
  app.delete('/api/admin/creators/:id', requireSameOrigin, requireAdmin, (req, res) => {
    const creator = db.prepare('SELECT id,creator_email,status FROM creator_sponsorships WHERE id=?').get(req.params.id);
    if (!creator) return res.status(404).json({ error: 'Creator sponsorship not found.' });
    db.prepare('DELETE FROM creator_sponsorships WHERE id=?').run(creator.id);
    audit(req.ownerAdmin, 'creator.removed', creator.id, { email: creator.creator_email, previousStatus: creator.status, accessRemoved: true });
    res.json({ ok: true, removed: true });
  });
  app.post('/api/admin/creators/:id/live', requireSameOrigin, requireAdmin, (req, res) => {
    const creator = db.prepare('SELECT * FROM creator_sponsorships WHERE id=?').get(req.params.id);
    if (!creator) return res.status(404).json({ error: 'Creator sponsorship not found.' });
    const account = db.prepare('SELECT id FROM customer_accounts WHERE email_normalized=?').get(creator.creator_email);
    if (!account) return res.status(409).json({ error: 'Creator has no customer account yet. Sponsorship is saved; activate Live after the creator account exists.' });
    try {
      const assignment = assignPlan(account.id, creator.plan_key, creator.duration_days, req.ownerAdmin, 'creator_sponsorship');
      db.prepare("UPDATE creator_sponsorships SET status='live',starts_at=?,ends_at=?,updated_at=? WHERE id=?")
        .run(assignment.startsAt,assignment.endsAt,isoNow(),creator.id);
      audit(req.ownerAdmin, 'creator.live_activated', creator.id, { email: creator.creator_email, ...assignment });
      res.json({ ok: true, assignment });
    } catch (error) { res.status(400).json({ error: String(error.message || error) }); }
  });
  app.get('/api/admin/developers', requireAdmin, (_req, res) => {
    res.json({ developers: db.prepare('SELECT id,subject_id AS subjectId,subject_type AS subjectType,label,status,unlimited,created_at AS createdAt,updated_at AS updatedAt FROM developer_entitlements ORDER BY created_at DESC').all() });
  });
  app.post('/api/admin/developers', requireSameOrigin, requireAdmin, (req, res) => {
    const subjectId = String(req.body?.subjectId || '').trim().slice(0,200);
    const subjectType = String(req.body?.subjectType || 'customer_id');
    const label = String(req.body?.label || '').trim().slice(0,120);
    if (!subjectId || !['customer_id','email'].includes(subjectType)) return res.status(400).json({ error: 'Enter an ID or email and choose its type.' });
    const id = crypto.randomUUID(), timestamp = isoNow();
    try {
      db.prepare('INSERT INTO developer_entitlements(id,subject_id,subject_type,label,status,unlimited,created_by,created_at,updated_at) VALUES(?,?,?,?,\'active\',1,?,?,?)')
        .run(id,subjectId,subjectType,label,req.ownerAdmin.id,timestamp,timestamp);
      audit(req.ownerAdmin, 'developer.unlimited_granted', id, { subjectId, subjectType });
      res.status(201).json({ ok: true, developer: { id,subjectId,subjectType,label,status:'active',unlimited:1 } });
    } catch (error) {
      if (String(error.message || error).includes('UNIQUE')) return res.status(409).json({ error: 'That ID already has a developer entitlement.' });
      res.status(400).json({ error: 'Could not save this developer ID.' });
    }
  });
  app.post('/api/admin/developers/:id/revoke', requireSameOrigin, requireAdmin, (req, res) => {
    const result = db.prepare("UPDATE developer_entitlements SET status='revoked',updated_at=? WHERE id=? AND status='active'").run(isoNow(),req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Active developer entitlement not found.' });
    audit(req.ownerAdmin, 'developer.unlimited_revoked', req.params.id);
    res.json({ ok: true });
  });
  app.get('/api/admin/audit', requireAdmin, (_req, res) => {
    res.json({ entries: db.prepare('SELECT id,actor_id AS actorId,action,target_id AS targetId,details_json AS details,created_at AS createdAt FROM admin_audit_log ORDER BY created_at DESC LIMIT 100').all() });
  });
  app.delete('/api/admin/audit', requireSameOrigin, requireAdmin, (req, res) => {
    const deleted = db.prepare('DELETE FROM admin_audit_log').run().changes;
    audit(req.ownerAdmin, 'audit.cleared', '', { deleted });
    res.json({ ok: true, deleted });
  });
}
