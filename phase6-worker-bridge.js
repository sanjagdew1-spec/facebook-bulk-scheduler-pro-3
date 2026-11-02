import crypto from 'node:crypto';

const PAGE_JOB_LIMIT = 10;
const MAX_CLAIM_LIMIT = 1000;
const MAX_RESPONSE_IMAGE_BYTES = 30 * 1024 * 1024;
let lastWorkerHeartbeatAt = 0;

export function isPhase6WorkerHealthy() {
  return lastWorkerHeartbeatAt > 0 && Date.now() - lastWorkerHeartbeatAt < 30000;
}

function authorized(req, secret) {
  const supplied = String(req.headers['x-phase6-worker-secret'] || '');
  if (!secret || !supplied) return false;
  const a = Buffer.from(secret), b = Buffer.from(supplied);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function groupByCustomerPage(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    const customerId = String(job.customer_id || ''), pageId = String(job.page_id || '');
    if (!customerId || !pageId) continue;
    const key = customerId + '::' + pageId;
    if (!groups.has(key)) groups.set(key, { customerId, pageId, jobs: [] });
    const group = groups.get(key);
    if (group.jobs.length < PAGE_JOB_LIMIT) group.jobs.push(job);
  }
  return [...groups.values()];
}

function markFailed(db, jobs, message, timestamp) {
  if (!jobs.length) return;
  const ids = jobs.map(job => job.id), marks = ids.map(() => '?').join(',');
  db.prepare("UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id IN (" + marks + ") AND status='scheduled'")
    .run(String(message).slice(0, 1500), timestamp, ...ids);
}

export function registerPhase6WorkerBridge(app, { db, getPhase5Access, decryptToken, now }) {
  const secret = String(process.env.PHASE6_WORKER_SECRET || '').trim();

  app.post('/internal/phase6/heartbeat', (req, res) => {
    if (!authorized(req, secret)) return res.status(401).json({ error: 'Phase 6 worker is not authorized.' });
    if (process.env.PHASE6_WORKER_MODE !== 'external') return res.status(409).json({ error: 'External Phase 6 worker mode is not enabled.' });
    lastWorkerHeartbeatAt = Date.now();
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, timestamp: new Date(lastWorkerHeartbeatAt).toISOString() });
  });

  app.post('/internal/phase6/claim', async (req, res) => {
    if (!authorized(req, secret)) return res.status(401).json({ error: 'Phase 6 worker is not authorized.' });
    if (process.env.PHASE6_WORKER_MODE !== 'external') return res.status(409).json({ error: 'External Phase 6 worker mode is not enabled.' });
    lastWorkerHeartbeatAt = Date.now();

    try {
      const requestedLimit = Number(req.body?.limit || 500);
      const limit = Math.max(1, Math.min(MAX_CLAIM_LIMIT, Math.floor(Number.isFinite(requestedLimit) ? requestedLimit : 500)));
      const due = db.prepare("SELECT j.id,j.user_id,j.page_id,j.scheduled_at,j.created_at,COALESCE(j.customer_id,(SELECT cfc.customer_id FROM customer_facebook_connections cfc WHERE cfc.facebook_user_id=j.user_id LIMIT 1)) AS customer_id FROM jobs j WHERE j.status='scheduled' AND j.scheduled_at<=? ORDER BY j.scheduled_at ASC,j.created_at ASC LIMIT ?")
        .all(now(), limit);

      const pageGroups = groupByCustomerPage(due), byCustomer = new Map();
      for (const group of pageGroups) {
        if (!byCustomer.has(group.customerId)) byCustomer.set(group.customerId, []);
        byCustomer.get(group.customerId).push(...group.jobs);
      }

      const claimed = [];
      for (const [customerId, customerJobs] of byCustomer.entries()) {
        const customer = db.prepare('SELECT status,email_normalized FROM customer_accounts WHERE id=?').get(customerId);
        if (!customer || customer.status !== 'active') {
          markFailed(db, customerJobs, 'Customer account is inactive; scheduled post was not published.', now());
          continue;
        }

        let access;
        try { access = await getPhase5Access(customer.email_normalized); }
        catch {
          const ids = customerJobs.map(job => job.id), marks = ids.map(() => '?').join(',');
          db.prepare("UPDATE jobs SET error=?,updated_at=? WHERE id IN (" + marks + ") AND status='scheduled'")
            .run('Plan access service is temporarily unavailable; this scheduled post will retry.', now(), ...ids);
          continue;
        }
        if (!access?.allowed) {
          markFailed(db, customerJobs, access?.message || 'No active plan is assigned to this account.', now());
          continue;
        }

        const ordered = [...customerJobs].sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at));
        const planStart = access.startsAt ? new Date(access.startsAt).toISOString() : '1970-01-01T00:00:00.000Z';
        const limited = !access.unlimited && access.role !== 'developer';
        const totalLimit = access.limits?.totalPosts == null ? NaN : Number(access.limits.totalPosts);
        const dailyLimit = access.limits?.postsPerDay == null ? NaN : Number(access.limits.postsPerDay);

        const reserve = db.transaction(() => {
          let totalRemaining = Infinity;
          if (limited && Number.isFinite(totalLimit)) {
            const used = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE customer_id=? AND created_at>=? AND status IN ('published','publishing')")
              .get(customerId, planStart).count;
            totalRemaining = Math.max(0, totalLimit - used);
          }
          const dailyRemaining = new Map();

          for (const job of ordered) {
            if (!access.unlimited && access.endsAt && Date.parse(job.scheduled_at) > Date.parse(access.endsAt)) {
              db.prepare("UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=? AND status='scheduled'")
                .run('Scheduled time is beyond the active plan expiry; post was not published.', now(), job.id);
              continue;
            }
            if (limited && totalRemaining <= 0) {
              db.prepare("UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=? AND status='scheduled'")
                .run('Total post allowance reached; this scheduled post was not published.', now(), job.id);
              continue;
            }

            let dayKey = null;
            if (limited && Number.isFinite(dailyLimit)) {
              const dayStart = new Date(job.scheduled_at);
              dayStart.setUTCHours(0, 0, 0, 0);
              const startIso = dayStart.toISOString(), endIso = new Date(dayStart.getTime() + 86400000).toISOString();
              dayKey = startIso;
              if (!dailyRemaining.has(dayKey)) {
                const used = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE customer_id=? AND scheduled_at>=? AND scheduled_at<? AND status IN ('published','publishing')")
                  .get(customerId, startIso, endIso).count;
                dailyRemaining.set(dayKey, Math.max(0, dailyLimit - used));
              }
              if (dailyRemaining.get(dayKey) <= 0) {
                db.prepare("UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=? AND status='scheduled'")
                  .run('Daily post allowance reached; this scheduled post was not published.', now(), job.id);
                continue;
              }
            }

            const claimId = crypto.randomUUID();
            const result = db.prepare("UPDATE jobs SET customer_id=COALESCE(customer_id,?),status='publishing',worker_claim_id=?,worker_claimed_at=?,error=NULL,updated_at=? WHERE id=? AND status='scheduled'")
              .run(customerId, claimId, now(), now(), job.id);
            if (!result.changes) continue;
            claimed.push({ id: job.id, customerId, claimId });
            if (limited && Number.isFinite(totalLimit)) totalRemaining--;
            if (dayKey !== null) dailyRemaining.set(dayKey, dailyRemaining.get(dayKey) - 1);
          }
        });
        reserve.immediate();
      }

      const jobs = [];
      let imageBytes = 0;
      for (const item of claimed) {
        const job = db.prepare("SELECT * FROM jobs WHERE id=? AND status='publishing' AND worker_claim_id=?").get(item.id, item.claimId);
        if (!job) continue;
        const encryptedPage = db.prepare('SELECT access_token FROM customer_pages WHERE customer_id=? AND facebook_user_id=? AND page_id=?')
          .get(item.customerId, job.user_id, job.page_id);
        const storedPhotos = db.prepare('SELECT image_data,image_mime_type FROM job_images WHERE job_id=? ORDER BY position').all(job.id);
        const photos = storedPhotos.length ? storedPhotos : (job.image_data?.length ? [{ image_data: job.image_data, image_mime_type: job.image_mime_type || 'image/jpeg' }] : []);
        const bytes = photos.reduce((sum, photo) => sum + (photo.image_data?.length || 0), 0);
        if (imageBytes + bytes > MAX_RESPONSE_IMAGE_BYTES && jobs.length) {
          db.prepare("UPDATE jobs SET status='scheduled',worker_claim_id=NULL,worker_claimed_at=NULL,updated_at=? WHERE id=? AND status='publishing' AND worker_claim_id=?")
            .run(now(), job.id, item.claimId);
          continue;
        }
        imageBytes += bytes;
        let pageAccessToken = '';
        try { pageAccessToken = encryptedPage?.access_token ? decryptToken(encryptedPage.access_token) : ''; } catch {}
        jobs.push({
          id: job.id, customer_id: item.customerId, user_id: job.user_id, page_id: job.page_id,
          page_name: job.page_name, message: job.message || '', image_url: job.image_url || '',
          is_ai_content: Number(job.is_ai_content || 0), retry_count: Number(job.retry_count || 0),
          claimId: item.claimId, pageAccessToken,
          photos: photos.map(photo => ({ mimeType: photo.image_mime_type || 'image/jpeg', dataBase64: Buffer.from(photo.image_data).toString('base64') }))
        });
      }

      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, claimedCount: jobs.length, jobs });
    } catch (error) {
      console.error('[phase6-claim] Failed:', String(error?.message || error));
      return res.status(500).json({ error: 'Could not claim scheduled posts for Phase 6.' });
    }
  });

  app.post('/internal/phase6/complete', (req, res) => {
    if (!authorized(req, secret)) return res.status(401).json({ error: 'Phase 6 worker is not authorized.' });
    if (process.env.PHASE6_WORKER_MODE !== 'external') return res.status(409).json({ error: 'External Phase 6 worker mode is not enabled.' });
    const jobId = String(req.body?.jobId || ''), claimId = String(req.body?.claimId || '');
    const outcome = String(req.body?.outcome || '');
    if (!jobId || !claimId || !['published', 'failed', 'retry'].includes(outcome)) {
      return res.status(400).json({ error: 'A valid job, claim, and completion outcome are required.' });
    }

    const timestamp = now();
    let result;
    if (outcome === 'published') {
      result = db.prepare("UPDATE jobs SET status='published',post_id=?,error=NULL,worker_claim_id=NULL,worker_claimed_at=NULL,updated_at=? WHERE id=? AND status='publishing' AND worker_claim_id=?")
        .run(String(req.body?.postId || '').slice(0, 255), timestamp, jobId, claimId);
    } else if (outcome === 'retry') {
      const retryAt = new Date(req.body?.retryAt || '');
      if (Number.isNaN(retryAt.getTime()) || retryAt.getTime() <= Date.now()) return res.status(400).json({ error: 'A future retry time is required.' });
      result = db.prepare("UPDATE jobs SET status='scheduled',scheduled_at=?,retry_count=retry_count+1,error=?,worker_claim_id=NULL,worker_claimed_at=NULL,updated_at=? WHERE id=? AND status='publishing' AND worker_claim_id=? AND retry_count<3")
        .run(retryAt.toISOString(), String(req.body?.error || 'Temporary Facebook connection failure; retry scheduled.').slice(0, 1500), timestamp, jobId, claimId);
    } else {
      result = db.prepare("UPDATE jobs SET status='failed',error=?,worker_claim_id=NULL,worker_claimed_at=NULL,updated_at=? WHERE id=? AND status='publishing' AND worker_claim_id=?")
        .run(String(req.body?.error || 'Facebook rejected the scheduled post.').slice(0, 1500), timestamp, jobId, claimId);
    }
    if (!result.changes) return res.status(409).json({ error: 'This worker claim is no longer active. The job status was not changed.' });
    return res.json({ ok: true, jobId, status: outcome === 'retry' ? 'scheduled' : outcome });
  });
}
