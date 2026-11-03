import crypto from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function metaError(data, status) {
  const error = data?.error || {};
  const parts = [error.message || 'Meta rejected the scheduled post.'];
  if (error.code != null) parts.push('Meta code ' + error.code);
  if (error.error_subcode != null) parts.push('subcode ' + error.error_subcode);
  if (status) parts.push('HTTP ' + status);
  return parts.join(' | ');
}

const META_DIRECT_WORKER_COUNT = 10;
const META_STAGE_CHUNK_LIMIT = 45 * 1024 * 1024;
const META_STAGE_BATCH_LIMIT = 350 * 1024 * 1024;
const META_STAGE_ROOT = path.join(os.tmpdir(), 'facebook-bulk-scheduler-meta-staging');

function diagnosticError(error) {
  const cause = error?.cause;
  return {
    name: error?.name || 'Error',
    message: String(error?.message || error || 'Unknown error').slice(0, 500),
    code: error?.code || cause?.code || null,
    causeName: cause?.name || null,
    causeCode: cause?.code || null,
    causeMessage: cause?.message ? String(cause.message).slice(0, 300) : null
  };
}

function logMetaDiagnostic(level, event, details) {
  const payload = { event, at: new Date().toISOString(), ...details };
  const line = JSON.stringify(payload);
  if (level === 'error') console.error('[meta-direct-diagnostic]', line);
  else if (level === 'warn') console.warn('[meta-direct-diagnostic]', line);
  else console.info('[meta-direct-diagnostic]', line);
}

async function mapWithConcurrency(items, limit, mapper) {
  let nextIndex = 0;
  let firstError = null;
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async (_, workerIndex) => {
    while (!firstError) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        await mapper(items[index], index, workerIndex + 1);
      } catch (error) {
        if (!firstError) firstError = error;
      }
    }
  });
  await Promise.all(workers);
  if (firstError) throw firstError;
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
    CREATE TABLE IF NOT EXISTS meta_schedule_upload_batches (
      request_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, facebook_user_id TEXT NOT NULL,
      expected_chunks INTEGER NOT NULL, expected_posts INTEGER NOT NULL,
      received_chunks INTEGER NOT NULL DEFAULT 0, received_posts INTEGER NOT NULL DEFAULT 0,
      target_count INTEGER NOT NULL DEFAULT 0, total_bytes INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta_schedule_upload_chunks (
      request_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, payload_hash TEXT NOT NULL,
      posts_count INTEGER NOT NULL, target_count INTEGER NOT NULL, payload_bytes INTEGER NOT NULL,
      PRIMARY KEY(request_id, chunk_index)
    );
  `);

  const directScheduleHandler = async (req, res) => {
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
        prepared.push({ clientPostId: item.clientPostId, postIndex: index + 1, message: String(item.message || ''), photos, targets: normalizedTargets, isAiContent: Boolean(item.isAiContent) });
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
      const tasks = prepared.flatMap(item => item.targets.map(target => ({ item, target })));
      const uniqueTaskKeys = new Set();
      for (const { item, target } of tasks) {
        const key = item.clientPostId + ':' + target.pageId;
        if (uniqueTaskKeys.has(key)) throw new Error('This batch contains the same post for the same Page more than once.');
        uniqueTaskKeys.add(key);
      }

      const processingStartedAt = Date.now();
      logMetaDiagnostic('info', 'batch_started', { requestId, postCount: prepared.length, pagePostJobs: tasks.length, workerCount: META_DIRECT_WORKER_COUNT });
      await mapWithConcurrency(tasks, META_DIRECT_WORKER_COUNT, async ({ item, target }, taskIndex, workerId) => {
        const taskStartedAt = Date.now();
        const taskContext = { requestId, taskIndex: taskIndex + 1, workerId, postIndex: item.postIndex, clientPostId: item.clientPostId, pageId: target.pageId, scheduledAt: target.scheduledAt };
        let currentOperation = 'task_prepare';
        logMetaDiagnostic('info', 'page_post_started', taskContext);
        const fingerprint = crypto.createHash('sha256').update(item.message).update(target.pageId).update(target.scheduledAt).update(Buffer.concat(item.photos.map(photo => photo.buffer))).digest('hex');
        const existing = db.prepare('SELECT page_id,page_name,scheduled_at,meta_post_id,status,content_fingerprint FROM meta_scheduled_posts WHERE customer_id=? AND client_post_id=? AND page_id=?').get(customerId, item.clientPostId, target.pageId);
        if (existing) {
          if (existing.content_fingerprint !== fingerprint) throw new Error('A post in this batch was already scheduled with different content. Do not retry the changed post; create a new slot instead.');
          results.push({ clientPostId: item.clientPostId, pageId: existing.page_id, pageName: existing.page_name, scheduledAt: existing.scheduled_at, metaPostId: existing.meta_post_id, status: existing.status, reused: true });
          logMetaDiagnostic('info', 'page_post_reused', { ...taskContext, metaPostId: existing.meta_post_id, durationMs: Date.now() - taskStartedAt });
          return;
        }
        const page = db.prepare('SELECT name,access_token FROM customer_pages WHERE customer_id=? AND facebook_user_id=? AND page_id=?')
          .get(customerId, facebookUserId, target.pageId);
        if (!page?.access_token) throw new Error('A selected Page is not connected. Refresh Pages and reconnect Facebook.');
        const pageToken = decryptToken(page.access_token);
        if (!pageToken) throw new Error('A selected Page access token could not be read. Reconnect Facebook.');

        // Each worker owns one complete Page-post task: its Page token, photos,
        // caption and schedule time stay together. Photo uploads remain sequential
        // inside that task; up to ten independent Page-post tasks run concurrently.
        const mediaIds = [];
        for (let photoIndex = 0; photoIndex < item.photos.length; photoIndex++) {
          const photo = item.photos[photoIndex];
          currentOperation = 'photo_upload';
          const operationStartedAt = Date.now();
          logMetaDiagnostic('info', 'operation_started', { ...taskContext, operation: currentOperation, photoIndex: photoIndex + 1, photoCount: item.photos.length });
          const form = new FormData();
          form.set('source', new Blob([photo.buffer], { type: photo.mime }), photo.mime === 'image/png' ? 'upload.png' : 'upload.jpg');
          form.set('published', 'false');
          form.set('temporary', 'true');
          form.set('access_token', pageToken);
          let uploadResponse;
          try {
            uploadResponse = await fetch(graph(target.pageId + '/photos'), { method: 'POST', body: form });
          } catch (error) {
            logMetaDiagnostic('error', 'operation_failed', { ...taskContext, operation: currentOperation, photoIndex: photoIndex + 1, durationMs: Date.now() - operationStartedAt, error: diagnosticError(error) });
            throw error;
          }
          const uploadData = await uploadResponse.json().catch(() => ({}));
          if (!uploadResponse.ok || uploadData.error || !uploadData.id) {
            const error = new Error(metaError(uploadData, uploadResponse.status));
            logMetaDiagnostic('error', 'operation_rejected', { ...taskContext, operation: currentOperation, photoIndex: photoIndex + 1, durationMs: Date.now() - operationStartedAt, httpStatus: uploadResponse.status, metaErrorCode: uploadData?.error?.code ?? null, metaErrorSubcode: uploadData?.error?.error_subcode ?? null, metaErrorType: uploadData?.error?.type ?? null, error: diagnosticError(error) });
            throw error;
          }
          mediaIds.push(String(uploadData.id));
          logMetaDiagnostic('info', 'operation_succeeded', { ...taskContext, operation: currentOperation, photoIndex: photoIndex + 1, durationMs: Date.now() - operationStartedAt, httpStatus: uploadResponse.status, mediaId: String(uploadData.id) });
        }

        currentOperation = 'feed_create';
        const feedStartedAt = Date.now();
        logMetaDiagnostic('info', 'operation_started', { ...taskContext, operation: currentOperation, photoCount: mediaIds.length });
        const feed = new URLSearchParams({
          message: item.message,
          published: 'false',
          scheduled_publish_time: String(Math.floor(target.date.getTime() / 1000)),
          unpublished_content_type: 'SCHEDULED',
          access_token: pageToken
        });
        mediaIds.forEach((mediaId, index) => feed.set('attached_media[' + index + ']', JSON.stringify({ media_fbid: mediaId })));
        let createResponse;
        try {
          createResponse = await fetch(graph(target.pageId + '/feed'), {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: feed
          });
        } catch (error) {
          logMetaDiagnostic('error', 'operation_failed', { ...taskContext, operation: currentOperation, durationMs: Date.now() - feedStartedAt, mediaCount: mediaIds.length, error: diagnosticError(error), outcome: 'facebook_acceptance_unknown' });
          throw error;
        }
        const created = await createResponse.json().catch(() => ({}));
        if (!createResponse.ok || created.error || !created.id) {
          const error = new Error(metaError(created, createResponse.status));
          logMetaDiagnostic('error', 'operation_rejected', { ...taskContext, operation: currentOperation, durationMs: Date.now() - feedStartedAt, httpStatus: createResponse.status, metaErrorCode: created?.error?.code ?? null, metaErrorSubcode: created?.error?.error_subcode ?? null, metaErrorType: created?.error?.type ?? null, error: diagnosticError(error) });
          throw error;
        }
        logMetaDiagnostic('info', 'operation_succeeded', { ...taskContext, operation: currentOperation, durationMs: Date.now() - feedStartedAt, httpStatus: createResponse.status, metaPostId: String(created.id) });

        const rowId = crypto.randomUUID();
        db.prepare(`INSERT INTO meta_scheduled_posts
          (id,request_id,client_post_id,customer_id,facebook_user_id,page_id,page_name,message,scheduled_at,meta_post_id,content_fingerprint,status,is_ai_content,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,'scheduled',?,?)`)
          .run(rowId, requestId, item.clientPostId, customerId, facebookUserId, target.pageId, page.name || 'Facebook Page',
            item.message, target.scheduledAt, String(created.id), fingerprint, item.isAiContent ? 1 : 0, now());
        results.push({
          clientPostId: item.clientPostId, pageId: target.pageId, pageName: page.name || 'Facebook Page',
          scheduledAt: target.scheduledAt, metaPostId: String(created.id), status: 'scheduled'
        });
        logMetaDiagnostic('info', 'page_post_scheduled', { ...taskContext, pageName: page.name || 'Facebook Page', metaPostId: String(created.id), durationMs: Date.now() - taskStartedAt });
      });
      console.info('[meta-direct-schedule-speed]', JSON.stringify({
        pagePostJobs: tasks.length,
        workerCount: META_DIRECT_WORKER_COUNT,
        activeWorkers: Math.min(META_DIRECT_WORKER_COUNT, tasks.length),
        processingMs: Date.now() - processingStartedAt,
        workerModel: 'shared-balanced-page-post-queue'
      }));
      logMetaDiagnostic('info', 'batch_succeeded', { requestId, pagePostJobs: tasks.length, confirmedPagePostJobs: results.length, processingMs: Date.now() - processingStartedAt });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(201).json({ ok: true, mode: 'meta-direct', requestedCount: targetCount, scheduledCount: results.length, results });
    } catch (error) {
      logMetaDiagnostic('error', 'batch_failed', { requestId, requestedPagePostJobs: targetCount, confirmedPagePostJobs: results.length, error: diagnosticError(error) });
      console.error('[meta-direct-schedule]', String(error?.message || error));
      res.setHeader('Cache-Control', 'no-store');
      if (results.length) return res.status(207).json({ ok: false, partial: true, error: String(error?.message || error), requestedCount: targetCount, scheduledCount: results.length, results });
      return res.status(400).json({ error: String(error?.message || error) });
    }
  };
  app.post('/api/meta-schedule', requireTrustedOrigin, requireAuth, requirePlanAccess, directScheduleHandler);

  const stageDirectory = (customerId, requestId) => path.join(META_STAGE_ROOT,
    crypto.createHash('sha256').update(String(customerId)).digest('hex'), requestId);
  async function clearStage(customerId, requestId) {
    await rm(stageDirectory(customerId, requestId), { recursive: true, force: true }).catch(() => {});
    db.prepare('DELETE FROM meta_schedule_upload_chunks WHERE request_id=?').run(requestId);
    db.prepare('DELETE FROM meta_schedule_upload_batches WHERE request_id=? AND customer_id=?').run(requestId, customerId);
  }
  async function clearExpiredStages() {
    const cutoff = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const rows = db.prepare('SELECT request_id,customer_id FROM meta_schedule_upload_batches WHERE created_at<?').all(cutoff);
    for (const row of rows) await clearStage(row.customer_id, row.request_id);
  }

  app.post('/api/meta-schedule/chunk', requireTrustedOrigin, requireAuth, requirePlanAccess, async (req, res) => {
    const { requestId, chunkIndex, totalChunks, totalPosts, posts } = req.body || {};
    const customerId = req.session.customerAccount.id, facebookUserId = req.session.fbUser.id;
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)
      || !Number.isInteger(chunkIndex) || !Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > 100
      || chunkIndex < 0 || chunkIndex >= totalChunks || !Number.isInteger(totalPosts) || totalPosts < 1 || totalPosts > 100
      || !Array.isArray(posts) || !posts.length || posts.length > totalPosts) {
      return res.status(400).json({ error: 'Invalid direct-scheduling upload chunk.' });
    }
    const payload = JSON.stringify(posts), payloadBytes = Buffer.byteLength(payload, 'utf8');
    if (payloadBytes > META_STAGE_CHUNK_LIMIT) return res.status(413).json({ error: 'Upload chunk is too large. Please retry the batch.' });
    const payloadHash = crypto.createHash('sha256').update(payload).digest('hex');
    let chunkTargets = 0;
    try {
      await clearExpiredStages();
      for (let i = 0; i < posts.length; i++) {
        const item = posts[i] || {};
        if (typeof item.clientPostId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(item.clientPostId)) throw new Error('Post ' + (i + 1) + ' is missing its unique post ID.');
        const images = Array.isArray(item.images) ? item.images : [];
        if (!images.length || images.length > 10) throw new Error('Post ' + (i + 1) + ' must contain 1 to 10 photos.');
        let postBytes = 0;
        for (const photo of images) {
          const match = typeof photo?.imageData === 'string' ? photo.imageData.match(/^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/) : null;
          if (!match) throw new Error('Post ' + (i + 1) + ' contains an invalid JPG/PNG image.');
          const bytes = Buffer.byteLength(match[2], 'base64');
          if (!bytes || bytes > 6 * 1024 * 1024) throw new Error('Each image must be 6 MB or smaller.');
          if (photo.imageMimeType && photo.imageMimeType !== match[1]) throw new Error('Image type mismatch in post ' + (i + 1) + '.');
          postBytes += bytes;
        }
        if (postBytes > 30 * 1024 * 1024) throw new Error('Photos in post ' + (i + 1) + ' must total 30 MB or less.');
        const targets = Array.isArray(item.pageSchedules) ? item.pageSchedules : [];
        if (!targets.length) throw new Error('Select at least one Page and schedule time for post ' + (i + 1) + '.');
        const seen = new Set();
        for (const target of targets) {
          const pageId = String(target?.pageId ?? ''), date = new Date(target?.scheduledAt);
          if (!pageId || seen.has(pageId)) throw new Error('Post ' + (i + 1) + ' contains a missing or duplicate Page.');
          seen.add(pageId);
          if (!target?.scheduledAt || Number.isNaN(date.getTime()) || date.getTime() < Date.now() + 10 * 60 * 1000) throw new Error('Every Facebook schedule time must be at least 10 minutes in the future.');
          chunkTargets++;
        }
      }
      const batch = db.prepare('SELECT * FROM meta_schedule_upload_batches WHERE request_id=?').get(requestId);
      if (batch && (batch.customer_id !== customerId || batch.facebook_user_id !== facebookUserId || batch.expected_chunks !== totalChunks || batch.expected_posts !== totalPosts)) {
        return res.status(409).json({ error: 'This upload batch ID is already in use.' });
      }
      if (!batch) db.prepare('INSERT INTO meta_schedule_upload_batches (request_id,customer_id,facebook_user_id,expected_chunks,expected_posts,created_at) VALUES(?,?,?,?,?,?)')
        .run(requestId, customerId, facebookUserId, totalChunks, totalPosts, now());
      const oldChunk = db.prepare('SELECT payload_hash FROM meta_schedule_upload_chunks WHERE request_id=? AND chunk_index=?').get(requestId, chunkIndex);
      if (oldChunk) {
        if (oldChunk.payload_hash !== payloadHash) return res.status(409).json({ error: 'This upload chunk was already received with different content.' });
        return res.status(200).json({ ok: true, received: true, reused: true, chunkIndex });
      }
      const current = db.prepare('SELECT total_bytes,target_count FROM meta_schedule_upload_batches WHERE request_id=?').get(requestId);
      if (current.total_bytes + payloadBytes > META_STAGE_BATCH_LIMIT) return res.status(413).json({ error: 'This batch exceeds the safe temporary upload limit.' });
      if (current.target_count + chunkTargets > 100) return res.status(400).json({ error: 'A direct Facebook schedule batch cannot exceed 100 Page posts.' });
      const dir = stageDirectory(customerId, requestId);
      await mkdir(dir, { recursive: true });
      const finalPath = path.join(dir, 'chunk-' + String(chunkIndex).padStart(3, '0') + '.json');
      await writeFile(finalPath + '.tmp', payload, 'utf8');
      await rename(finalPath + '.tmp', finalPath);
      try {
        db.transaction(() => {
          db.prepare('INSERT INTO meta_schedule_upload_chunks (request_id,chunk_index,payload_hash,posts_count,target_count,payload_bytes) VALUES(?,?,?,?,?,?)')
            .run(requestId, chunkIndex, payloadHash, posts.length, chunkTargets, payloadBytes);
          db.prepare('UPDATE meta_schedule_upload_batches SET received_chunks=received_chunks+1,received_posts=received_posts+?,target_count=target_count+?,total_bytes=total_bytes+? WHERE request_id=?')
            .run(posts.length, chunkTargets, payloadBytes, requestId);
        })();
      } catch (error) { await rm(finalPath, { force: true }).catch(() => {}); throw error; }
      return res.status(200).json({ ok: true, received: true, chunkIndex });
    } catch (error) { return res.status(400).json({ error: String(error?.message || error) }); }
  });

  app.post('/api/meta-schedule/abort', requireTrustedOrigin, requireAuth, requirePlanAccess, async (req, res) => {
    const requestId = req.body?.requestId, customerId = req.session.customerAccount.id;
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) return res.status(400).json({ error: 'A valid upload batch ID is required.' });
    const row = db.prepare('SELECT request_id FROM meta_schedule_upload_batches WHERE request_id=? AND customer_id=?').get(requestId, customerId);
    if (row) await clearStage(customerId, requestId);
    return res.status(200).json({ ok: true });
  });

  app.post('/api/meta-schedule/commit', requireTrustedOrigin, requireAuth, requirePlanAccess, async (req, res) => {
    const requestId = req.body?.requestId, customerId = req.session.customerAccount.id, facebookUserId = req.session.fbUser.id;
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) return res.status(400).json({ error: 'A valid upload batch ID is required.' });
    const batch = db.prepare('SELECT * FROM meta_schedule_upload_batches WHERE request_id=? AND customer_id=? AND facebook_user_id=?').get(requestId, customerId, facebookUserId);
    if (!batch) return res.status(404).json({ error: 'The staged batch was not found. Please start Direct Schedule Facebook again.' });
    if (batch.received_chunks !== batch.expected_chunks || batch.received_posts !== batch.expected_posts) return res.status(409).json({ error: 'All photo chunks must finish uploading before scheduling starts.' });
    const chunks = db.prepare('SELECT chunk_index,posts_count FROM meta_schedule_upload_chunks WHERE request_id=? ORDER BY chunk_index').all(requestId);
    if (chunks.length !== batch.expected_chunks) return res.status(409).json({ error: 'One or more photo chunks are missing. No posts were scheduled.' });
    const dir = stageDirectory(customerId, requestId), allPageIds = [], scheduledDates = [], duplicateKeys = new Set();
    let totalTargets = 0;
    try {
      // Validate every chunk before the first Meta request, so upload/validation errors cannot leave a partial batch.
      for (const chunk of chunks) {
        const file = path.join(dir, 'chunk-' + String(chunk.chunk_index).padStart(3, '0') + '.json');
        const posts = JSON.parse(await readFile(file, 'utf8'));
        if (!Array.isArray(posts) || posts.length !== chunk.posts_count) return res.status(409).json({ error: 'A photo chunk is incomplete. No posts were scheduled.' });
        for (const item of posts) {
          const images = Array.isArray(item.images) ? item.images : [];
          if (!images.length || images.length > 10) return res.status(400).json({ error: 'A staged post has an invalid photo count. No posts were scheduled.' });
          let postBytes = 0;
          for (const photo of images) {
            const match = typeof photo?.imageData === 'string' ? photo.imageData.match(/^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/) : null;
            if (!match) return res.status(400).json({ error: 'A staged photo is invalid. No posts were scheduled.' });
            const bytes = Buffer.byteLength(match[2], 'base64');
            if (!bytes || bytes > 6 * 1024 * 1024) return res.status(400).json({ error: 'A staged photo exceeds 6 MB. No posts were scheduled.' });
            postBytes += bytes;
          }
          if (postBytes > 30 * 1024 * 1024) return res.status(400).json({ error: 'Photos in one post exceed 30 MB. No posts were scheduled.' });
          for (const target of item.pageSchedules || []) {
            const pageId = String(target.pageId || ''), date = new Date(target.scheduledAt);
            const key = String(item.clientPostId) + ':' + pageId;
            if (!pageId || duplicateKeys.has(key) || Number.isNaN(date.getTime()) || date.getTime() < Date.now() + 10 * 60 * 1000) return res.status(400).json({ error: 'The staged batch has a duplicate Page or invalid schedule time. No posts were scheduled.' });
            duplicateKeys.add(key); allPageIds.push(pageId); scheduledDates.push(date); totalTargets++;
          }
        }
      }
      if (totalTargets !== batch.target_count || totalTargets > 100) return res.status(409).json({ error: 'The staged batch totals do not match. No posts were scheduled.' });
      // Confirm every selected Page still has a usable token before scheduling any chunk.
      for (const pageId of new Set(allPageIds)) {
        const page = db.prepare('SELECT access_token FROM customer_pages WHERE customer_id=? AND facebook_user_id=? AND page_id=?').get(customerId, facebookUserId, pageId);
        if (!page?.access_token || !decryptToken(page.access_token)) return res.status(400).json({ error: 'A selected Page is no longer connected. No posts were scheduled.' });
      }
      if (!enforcePlanLimits(req, res, { batchCount: totalTargets, targetCount: totalTargets, pageIds: allPageIds, scheduledDates })) return;
      const access = req.planAccess || {};
      if (!access.unlimited && access.role !== 'developer') {
        const limits = access.limits || {}, planStart = access.startsAt ? new Date(access.startsAt).toISOString() : '1970-01-01T00:00:00.000Z';
        const totalLimit = Number(limits.totalPosts);
        if (Number.isFinite(totalLimit)) {
          const oldJobs = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE customer_id=? AND created_at>=? AND status IN ('scheduled','publishing','published')").get(customerId, planStart).count;
          const metaJobs = db.prepare("SELECT COUNT(*) AS count FROM meta_scheduled_posts WHERE customer_id=? AND created_at>=? AND status='scheduled'").get(customerId, planStart).count;
          if (oldJobs + metaJobs + totalTargets > totalLimit) return res.status(400).json({ error: 'Your ' + (access.planName || 'plan') + ' post limit would be exceeded. No posts were scheduled.' });
        }
        const dailyLimit = Number(limits.postsPerDay);
        if (Number.isFinite(dailyLimit)) {
          const byDay = scheduledDates.reduce((acc, date) => { const d = new Date(date); d.setUTCHours(0,0,0,0); const key=d.toISOString(); acc[key]=(acc[key]||0)+1; return acc; }, {});
          for (const [dayStart,count] of Object.entries(byDay)) {
            const dayEnd = new Date(Date.parse(dayStart)+86400000).toISOString();
            const oldJobs = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE customer_id=? AND scheduled_at>=? AND scheduled_at<? AND status IN ('scheduled','publishing','published')").get(customerId,dayStart,dayEnd).count;
            const metaJobs = db.prepare("SELECT COUNT(*) AS count FROM meta_scheduled_posts WHERE customer_id=? AND scheduled_at>=? AND scheduled_at<? AND status='scheduled'").get(customerId,dayStart,dayEnd).count;
            if (oldJobs + metaJobs + count > dailyLimit) return res.status(400).json({ error: 'Your daily post limit would be exceeded for ' + dayStart.slice(0,10) + '. No posts were scheduled.' });
          }
        }
      }
      const results = []; let failure = null;
      for (const chunk of chunks) {
        const file = path.join(dir, 'chunk-' + String(chunk.chunk_index).padStart(3, '0') + '.json');
        const posts = JSON.parse(await readFile(file, 'utf8'));
        const chunkRes = { statusCode:200, body:null, status(code){this.statusCode=code;return this;}, setHeader(){}, json(value){this.body=value;return this;} };
        await directScheduleHandler({ ...req, body:{ requestId:requestId+'_chunk_'+chunk.chunk_index, posts } }, chunkRes);
        if (Array.isArray(chunkRes.body?.results)) results.push(...chunkRes.body.results);
        if (chunkRes.statusCode !== 201 || !chunkRes.body?.ok) { failure = chunkRes.body?.error || 'Facebook did not confirm every post.'; break; }
      }
      await clearStage(customerId, requestId);
      if (failure) {
        res.setHeader('Cache-Control','no-store');
        if (results.length) return res.status(207).json({ ok:false, partial:true, error:failure, requestedCount:totalTargets, scheduledCount:results.length, results });
        return res.status(400).json({ error:failure, requestedCount:totalTargets, scheduledCount:0, results:[] });
      }
      res.setHeader('Cache-Control','no-store');
      return res.status(201).json({ ok:true, mode:'meta-direct', requestedCount:totalTargets, scheduledCount:results.length, results });
    } catch (error) {
      logMetaDiagnostic('error','staged_batch_commit_failed',{requestId,error:diagnosticError(error)});
      return res.status(500).json({ error:'The staged batch could not be completed: '+String(error?.message||error) });
    }
  });

}
