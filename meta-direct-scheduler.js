import crypto from 'node:crypto';

function metaError(data, status) {
  const error = data?.error || {};
  const parts = [error.message || 'Meta rejected the scheduled post.'];
  if (error.code != null) parts.push('Meta code ' + error.code);
  if (error.error_subcode != null) parts.push('subcode ' + error.error_subcode);
  if (status) parts.push('HTTP ' + status);
  return parts.join(' | ');
}

function parsePhoto(photo, postIndex) {
  const match = typeof photo?.imageData === 'string'
    ? photo.imageData.match(/^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/)
    : null;
  if (!match) throw new Error('Post ' + (postIndex + 1) + ' contains an invalid JPG/PNG image.');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 6 * 1024 * 1024) throw new Error('Each image must be 6 MB or smaller.');
  if (photo.imageMimeType && photo.imageMimeType !== match[1]) throw new Error('Image type mismatch in post ' + (postIndex + 1) + '.');
  return { buffer, mime: match[1] };
}

export function registerMetaDirectScheduleRoute(app, {
  db, requireTrustedOrigin, requireAuth, requirePlanAccess, enforcePlanLimits,
  decryptToken, graph, now
}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta_scheduled_posts (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      client_post_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      facebook_user_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      page_name TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      scheduled_at TEXT NOT NULL,
      meta_post_id TEXT NOT NULL,
      content_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      is_ai_content INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(customer_id, client_post_id, page_id)
    );
    CREATE INDEX IF NOT EXISTS meta_scheduled_customer_time_idx
      ON meta_scheduled_posts(customer_id, scheduled_at, status);
  `);

  app.post('/api/meta-schedule', requireTrustedOrigin, requireAuth, requirePlanAccess, async (req, res) => {
    const { posts, requestId } = req.body || {};
    if (!Array.isArray(posts) || posts.length < 1 || posts.length > 100) {
      return res.status(400).json({ error: 'A direct Facebook schedule batch must contain 1 to 100 photo posts.' });
    }
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) {
      return res.status(400).json({ error: 'A valid batch request ID is required.' });
    }

    const prepared = [];
    const allPageIds = [];
    const scheduledDates = [];
    let targetCount = 0;
    const results = [];
    try {
      for (let index = 0; index < posts.length; index++) {
        const item = posts[index] || {};
        if (typeof item.clientPostId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(item.clientPostId)) throw new Error('Post ' + (index + 1) + ' is missing its unique post ID.');
        const images = Array.isArray(item.images) ? item.images : [];
        if (!images.length || images.length > 10) throw new Error('Post ' + (index + 1) + ' must contain 1 to 10 photos.');
        const photos = images.map(photo => parsePhoto(photo, index));
        if (photos.reduce((sum, photo) => sum + photo.buffer.length, 0) > 30 * 1024 * 1024) {
          throw new Error('Photos in post ' + (index + 1) + ' must total 30 MB or less.');
        }
        const targets = Array.isArray(item.pageSchedules) ? item.pageSchedules : [];
        if (!targets.length) throw new Error('Select at least one Page and schedule time for post ' + (index + 1) + '.');
        const seen = new Set();
        const normalizedTargets = [];
        for (const target of targets) {
          const pageId = String(target?.pageId ?? '');
          const date = new Date(target?.scheduledAt);
          if (!pageId || seen.has(pageId)) throw new Error('Post ' + (index + 1) + ' contains a missing or duplicate Page.');
          seen.add(pageId);
          if (!target?.scheduledAt || Number.isNaN(date.getTime()) || date.getTime() < Date.now() + 10 * 60 * 1000) {
            throw new Error('Every Facebook schedule time must be at least 10 minutes in the future.');
          }
          normalizedTargets.push({ pageId, scheduledAt: date.toISOString(), date });
          allPageIds.push(pageId);
          scheduledDates.push(date);
          targetCount++;
        }
        prepared.push({ clientPostId: item.clientPostId, message: String(item.message || ''), photos, targets: normalizedTargets, isAiContent: Boolean(item.isAiContent) });
      }

      if (targetCount > 100) throw new Error('A direct Facebook schedule batch cannot exceed 100 Page posts.');
      const declaredBatchCount = posts.length;
      if (!enforcePlanLimits(req, res, {
        batchCount: targetCount,
        targetCount,
        pageIds: allPageIds,
        scheduledDates
      })) return;

      // Include Meta-owned scheduled posts in the customer's limits without making them
      // eligible for Phase 3/Phase 6 publishing. Existing jobs remain untouched.
      const access = req.planAccess || {};
      if (!access.unlimited && access.role !== 'developer') {
        const limits = access.limits || {};
        const customerId = req.session.customerAccount.id;
        const planStart = access.startsAt ? new Date(access.startsAt).toISOString() : '1970-01-01T00:00:00.000Z';
        const totalLimit = Number(limits.totalPosts);
        if (Number.isFinite(totalLimit)) {
          const oldJobs = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE customer_id=? AND created_at>=? AND status IN ('scheduled','publishing','published')").get(customerId, planStart).count;
          const metaJobs = db.prepare("SELECT COUNT(*) AS count FROM meta_scheduled_posts WHERE customer_id=? AND created_at>=? AND status='scheduled'").get(customerId, planStart).count;
          if (oldJobs + metaJobs + targetCount > totalLimit) throw new Error('Your ' + (access.planName || 'plan') + ' post limit would be exceeded.');
        }
        const dailyLimit = Number(limits.postsPerDay);
        if (Number.isFinite(dailyLimit)) {
          for (const [dayStart, count] of Object.entries(scheduledDates.reduce((acc, date) => {
            const d = new Date(date); d.setUTCHours(0,0,0,0);
            const key = d.toISOString(); acc[key] = (acc[key] || 0) + 1; return acc;
          }, {}))) {
            const dayEnd = new Date(Date.parse(dayStart) + 86400000).toISOString();
            const oldJobs = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE customer_id=? AND scheduled_at>=? AND scheduled_at<? AND status IN ('scheduled','publishing','published')").get(customerId, dayStart, dayEnd).count;
            const metaJobs = db.prepare("SELECT COUNT(*) AS count FROM meta_scheduled_posts WHERE customer_id=? AND scheduled_at>=? AND scheduled_at<? AND status='scheduled'").get(customerId, dayStart, dayEnd).count;
            if (oldJobs + metaJobs + count > dailyLimit) throw new Error('Your daily post limit would be exceeded for ' + dayStart.slice(0,10) + '.');
          }
        }
      }

      const customerId = req.session.customerAccount.id;
      const facebookUserId = req.session.fbUser.id;
      for (const item of prepared) {
        for (const target of item.targets) {
          const fingerprint = crypto.createHash('sha256').update(item.message).update(target.pageId).update(target.scheduledAt).update(Buffer.concat(item.photos.map(photo => photo.buffer))).digest('hex');
          const existing = db.prepare('SELECT page_id,page_name,scheduled_at,meta_post_id,status,content_fingerprint FROM meta_scheduled_posts WHERE customer_id=? AND client_post_id=? AND page_id=?').get(customerId, item.clientPostId, target.pageId);
          if (existing) {
            if (existing.content_fingerprint !== fingerprint) throw new Error('A post in this batch was already scheduled with different content. Do not retry the changed post; create a new slot instead.');
            results.push({ pageId: existing.page_id, pageName: existing.page_name, scheduledAt: existing.scheduled_at, metaPostId: existing.meta_post_id, status: existing.status, reused: true });
            continue;
          }
          const page = db.prepare('SELECT name,access_token FROM customer_pages WHERE customer_id=? AND facebook_user_id=? AND page_id=?')
            .get(customerId, facebookUserId, target.pageId);
          if (!page?.access_token) throw new Error('A selected Page is not connected. Refresh Pages and reconnect Facebook.');
          const pageToken = decryptToken(page.access_token);
          if (!pageToken) throw new Error('A selected Page access token could not be read. Reconnect Facebook.');

          // Upload each image as unpublished media, then create one Meta-owned scheduled
          // Page feed post. No local Phase 3/6 publish job is created for this post.
          const mediaIds = [];
          for (const photo of item.photos) {
            const form = new FormData();
            form.set('source', new Blob([photo.buffer], { type: photo.mime }), photo.mime === 'image/png' ? 'upload.png' : 'upload.jpg');
            form.set('published', 'false');
            form.set('temporary', 'true');
            form.set('access_token', pageToken);
            const uploadResponse = await fetch(graph(target.pageId + '/photos'), { method: 'POST', body: form });
            const uploadData = await uploadResponse.json().catch(() => ({}));
            if (!uploadResponse.ok || uploadData.error || !uploadData.id) throw new Error(metaError(uploadData, uploadResponse.status));
            mediaIds.push(String(uploadData.id));
          }

          const feed = new URLSearchParams({
            message: item.message,
            published: 'false',
            scheduled_publish_time: String(Math.floor(target.date.getTime() / 1000)),
            unpublished_content_type: 'SCHEDULED',
            access_token: pageToken
          });
          mediaIds.forEach((mediaId, index) => feed.set('attached_media[' + index + ']', JSON.stringify({ media_fbid: mediaId })));
          const createResponse = await fetch(graph(target.pageId + '/feed'), {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: feed
          });
          const created = await createResponse.json().catch(() => ({}));
          if (!createResponse.ok || created.error || !created.id) throw new Error(metaError(created, createResponse.status));

          const rowId = crypto.randomUUID();
          db.prepare(`INSERT INTO meta_scheduled_posts
            (id,request_id,client_post_id,customer_id,facebook_user_id,page_id,page_name,message,scheduled_at,meta_post_id,content_fingerprint,status,is_ai_content,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,'scheduled',?,?)`)
            .run(rowId, requestId, item.clientPostId, customerId, facebookUserId, target.pageId, page.name || 'Facebook Page',
              item.message, target.scheduledAt, String(created.id), fingerprint, item.isAiContent ? 1 : 0, now());
          results.push({
            pageId: target.pageId, pageName: page.name || 'Facebook Page',
            scheduledAt: target.scheduledAt, metaPostId: String(created.id), status: 'scheduled'
          });
        }
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(201).json({ ok: true, mode: 'meta-direct', requestedCount: targetCount, scheduledCount: results.length, results });
    } catch (error) {
      console.error('[meta-direct-schedule]', String(error?.message || error));
      res.setHeader('Cache-Control', 'no-store');
      if (results.length) return res.status(207).json({ ok: false, partial: true, error: String(error?.message || error), requestedCount: targetCount, scheduledCount: results.length, results });
      return res.status(400).json({ error: String(error?.message || error) });
    }
  });
}
