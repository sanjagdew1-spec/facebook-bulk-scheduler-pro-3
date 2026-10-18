import crypto from 'node:crypto';
import { hashCustomerPassword, verifyCustomerPassword, normalizeCustomerEmail } from './customer-auth.js';

// Phase 2 Part 1 pilot cap. Raising/removing this cap belongs to Part 2.
export const MAX_CUSTOMER_ACCOUNTS = 20;

export function registerCustomerAuthRoutes(app, { db, trustedOrigins }) {
  const attempts = new Map();
  const windowMs = 15 * 60 * 1000;
  const maxAttempts = 12;

  function trustedOrigin(req, res, next) {
    const origin = req.headers.origin;
    if (!origin || !trustedOrigins.has(origin)) {
      return res.status(403).json({ error: 'Request origin could not be verified. Open the official app and try again.' });
    }
    next();
  }

  function limitAttempts(req, res, next) {
    const key = String(req.ip || req.socket?.remoteAddress || 'unknown');
    const time = Date.now();
    if (attempts.size > 5000) {
      for (const [ip, entry] of attempts) {
        if (time - entry.startedAt > windowMs) attempts.delete(ip);
      }
    }
    const previous = attempts.get(key);
    if (!previous || time - previous.startedAt > windowMs) {
      attempts.set(key, { startedAt: time, count: 1 });
      return next();
    }
    if (previous.count >= maxAttempts) {
      res.setHeader('Retry-After', String(Math.ceil((windowMs - (time - previous.startedAt)) / 1000)));
      return res.status(429).json({ error: 'Too many sign-in attempts. Please wait and try again.' });
    }
    previous.count++;
    next();
  }

  function createUniqueUsername() {
    for (let attempt = 0; attempt < 8; attempt++) {
      const username = 'user_' + crypto.randomBytes(4).toString('hex');
      if (!db.prepare('SELECT id FROM customer_accounts WHERE username = ?').get(username)) return username;
    }
    throw new Error('Could not allocate a unique username.');
  }

  async function sendWelcomeEmail(email, username) {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM;
    if (!apiKey || !from) return { sent: false, reason: 'not_configured' };
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to: [email],
          subject: 'Your Facebook Bulk Scheduler Pro account is ready',
          text: 'Your Facebook Bulk Scheduler Pro customer account was created.\\n\\nUsername: ' + username + '\\nEmail: ' + email + '\\n\\nSign in using your email and the password you created. This is separate from your Facebook password.\\n\\nIf you did not create this account, you can ignore this email.'
        })
      });
      if (!response.ok) {
        console.warn('[customer-email] Provider rejected welcome email with status', response.status);
        return { sent: false, reason: 'provider_error' };
      }
      return { sent: true };
    } catch (error) {
      console.warn('[customer-email] Could not send welcome email:', String(error?.message || error));
      return { sent: false, reason: 'provider_error' };
    }
  }

  function createUniqueUsername() {
    for (let attempt = 0; attempt < 8; attempt++) {
      const username = 'user_' + crypto.randomBytes(4).toString('hex');
      if (!db.prepare('SELECT id FROM customer_accounts WHERE username = ?').get(username)) return username;
    }
    throw new Error('Could not allocate a unique username.');
  }

  async function sendWelcomeEmail(email, username) {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM;
    if (!apiKey || !from) return { sent: false, reason: 'not_configured' };
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to: [email],
          subject: 'Your Facebook Bulk Scheduler Pro account is ready',
          text: 'Your Facebook Bulk Scheduler Pro customer account was created.\\n\\nUsername: ' + username + '\\nEmail: ' + email + '\\n\\nSign in using your email and the password you created. This is separate from your Facebook password.\\n\\nIf you did not create this account, you can ignore this email.'
        })
      });
      if (!response.ok) {
        console.warn('[customer-email] Provider rejected welcome email with status', response.status);
        return { sent: false, reason: 'provider_error' };
      }
      return { sent: true };
    } catch (error) {
      console.warn('[customer-email] Could not send welcome email:', String(error?.message || error));
      return { sent: false, reason: 'provider_error' };
    }
  }

  function saveCustomerSession(req, customer) {
    return new Promise((resolve, reject) => {
      req.session.regenerate(err => {
        if (err) return reject(err);
        req.session.customerAccount = { id: customer.id, email: customer.email_normalized, username: customer.username };
        req.session.save(saveErr => saveErr ? reject(saveErr) : resolve());
      });
    });
  }

  app.post('/api/customer/register', trustedOrigin, limitAttempts, async (req, res) => {
    const email = normalizeCustomerEmail(req.body?.email);
    const password = req.body?.password;
    if (!email) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
      return res.status(400).json({ error: 'Password must be 10–128 characters long.' });
    }
    try {
      const passwordHash = await hashCustomerPassword(password);
      const id = crypto.randomUUID();
      const username = createUniqueUsername();
      const timestamp = new Date().toISOString();

      // Atomic capacity check + insert: simultaneous registrations cannot exceed 20.
      const result = db.transaction(() => {
        if (db.prepare('SELECT id FROM customer_accounts WHERE email_normalized = ?').get(email)) {
          return { kind: 'duplicate' };
        }
        const count = db.prepare('SELECT COUNT(*) AS count FROM customer_accounts').get().count;
        if (count >= MAX_CUSTOMER_ACCOUNTS) return { kind: 'capacity' };
        db.prepare('INSERT INTO customer_accounts(id,email_normalized,username,password_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
          .run(id, email, username, passwordHash, 'active', timestamp, timestamp);
        return { kind: 'created' };
      })();

      if (result.kind === 'duplicate') {
        return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
      }
      if (result.kind === 'capacity') {
        return res.status(409).json({
          error: 'The 20-customer pilot is currently full. New registrations are paused until the pilot limit is changed.'
        });
      }

      const customer = { id, email_normalized: email, username };
      await saveCustomerSession(req, customer);
      const emailResult = await sendWelcomeEmail(email, username);
      return res.status(201).json({ ok: true, customer: { id, email, username }, emailNotice: emailResult.sent ? 'sent' : emailResult.reason });
    } catch (error) {
      console.error('[customer-register] Failed:', String(error?.message || error));
      return res.status(500).json({ error: 'Could not create the account right now. Please try again.' });
    }
  });

  app.post('/api/customer/login', trustedOrigin, limitAttempts, async (req, res) => {
    const email = normalizeCustomerEmail(req.body?.email);
    const password = req.body?.password;
    if (!email || typeof password !== 'string' || password.length > 128) {
      return res.status(400).json({ error: 'Enter your email and password.' });
    }
    try {
      const customer = db.prepare('SELECT id,email_normalized,username,password_hash,status FROM customer_accounts WHERE email_normalized = ?').get(email);
      const valid = Boolean(customer?.status === 'active' && await verifyCustomerPassword(password, customer.password_hash));
      if (!valid) return res.status(401).json({ error: 'Email or password is incorrect.' });
      await saveCustomerSession(req, customer);
      return res.json({ ok: true, customer: { id: customer.id, email: customer.email_normalized, username: customer.username } });
    } catch (error) {
      console.error('[customer-login] Failed:', String(error?.message || error));
      return res.status(500).json({ error: 'Could not sign in right now. Please try again.' });
    }
  });

  app.get('/api/customer/status', (req, res) => {
    const sessionCustomer = req.session.customerAccount;
    if (!sessionCustomer?.id) return res.json({ signedIn: false, customer: null });
    const customer = db.prepare('SELECT id,email_normalized,username,status FROM customer_accounts WHERE id=?').get(sessionCustomer.id);
    if (!customer || customer.status !== 'active') {
      return req.session.destroy(() => res.json({ signedIn: false, customer: null }));
    }
    return res.json({ signedIn: true, customer: { id: customer.id, email: customer.email_normalized, username: customer.username } });
  });

  app.post('/api/customer/logout', trustedOrigin, (req, res) => {
    req.session.destroy(error => {
      if (error) return res.status(500).json({ error: 'Could not sign out. Please try again.' });
      res.clearCookie('fb_scheduler_sid', { httpOnly: true, secure: true, sameSite: 'none' });
      return res.json({ ok: true });
    });
  });
}
