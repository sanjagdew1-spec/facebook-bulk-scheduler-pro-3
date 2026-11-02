import http from 'node:http';
import { groupJobsByPage, runPageWorkers } from './page-worker-scheduler.js';

const PHASE3_API_URL = String(process.env.PHASE3_API_URL || '').replace(/\/$/, '');
const WORKER_SECRET = String(process.env.PHASE6_WORKER_SECRET || '').trim();
const GRAPH_VERSION = 'v26.0';
const GRAPH_BASE_URL = 'https://graph.facebook.com/' + GRAPH_VERSION;
const PORT = Number(process.env.PORT || 3000);
const POLL_INTERVAL_MS = Math.max(2000, Number(process.env.PHASE6_POLL_INTERVAL_MS || 5000));
const MAX_WORKERS_PER_CUSTOMER = Math.max(1, Math.min(10, Number.parseInt(process.env.PUBLISH_MAX_PAGE_WORKERS_PER_CUSTOMER || '10', 10) || 10));
const MAX_JOBS_PER_PAGE = 10;
const WORKER_ENABLED = String(process.env.PHASE6_ENABLED || 'false').toLowerCase() === 'true';

if (!PHASE3_API_URL || !WORKER_SECRET) {
  throw new Error('Phase 6 requires PHASE3_API_URL and PHASE6_WORKER_SECRET. No local database is configured or opened.');
}

let stopping = false;
let activePass = false;
let lastPollAt = null;
let lastSuccessAt = null;
let lastError = null;

async function phase3Request(path, body) {
  const response = await fetch(PHASE3_API_URL + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-phase6-worker-secret': WORKER_SECRET
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || ('Phase 3 returned HTTP ' + response.status));
  return data;
}

function graph(path) {
  return GRAPH_BASE_URL + '/' + path;
}

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

function safePublishTransportRetryCode(error) {
  const cause = error?.cause || {};
  const code = String(cause.code || cause.cause?.code || error?.code || '');
  if (['EAI_AGAIN','ENOTFOUND','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','UND_ERR_CONNECT_TIMEOUT'].includes(code)) return code;
  if (code === 'UND_ERR_SOCKET' && Number(cause.socket?.bytesWritten || 0) === 0) return code;
  return null;
}

async function complete(job, outcome, extra = {}) {
  return phase3Request('/internal/phase6/complete', {
    jobId: job.id,
    claimId: job.claimId,
    outcome,
    ...extra
  });
}

async function publishToFacebook(job) {
  if (!job.pageAccessToken) throw new Error('Page token missing. Reconnect Facebook and refresh Pages.');
  const photos = Array.isArray(job.photos) ? job.photos : [];
  const isAi = Boolean(Number(job.is_ai_content || 0));
  let response;

  if (photos.length > 1) {
    const mediaIds = [];
    for (const photo of photos) {
      const bytes = Buffer.from(photo.dataBase64 || '', 'base64');
      if (!bytes.length) throw new Error('A scheduled photo could not be read from the Phase 3 database.');
      const body = new FormData();
      body.set('source', new Blob([bytes], { type: photo.mimeType || 'image/jpeg' }), photo.mimeType === 'image/png' ? 'upload.png' : 'upload.jpg');
      body.set('published', 'false');
      body.set('is_gen_ai', isAi ? 'true' : 'false');
      body.set('created_with_ai', isAi ? 'true' : 'false');
      body.set('edited_with_ai', 'false');
      body.set('provenance_type', isAi ? 'EXPLICIT' : 'NONE');
      body.set('access_token', job.pageAccessToken);
      const uploadResponse = await fetch(graph(job.page_id + '/photos'), { method: 'POST', body });
      const uploadData = await uploadResponse.json().catch(() => ({}));
      if (!uploadResponse.ok || uploadData.error || !uploadData.id) throw new Error(describeMetaError(uploadData, uploadResponse.status));
      mediaIds.push(String(uploadData.id));
    }
    const feedBody = new URLSearchParams({
      message: job.message || '',
      access_token: job.pageAccessToken,
      is_gen_ai: isAi ? 'true' : 'false',
      created_with_ai: isAi ? 'true' : 'false',
      edited_with_ai: 'false',
      provenance_type: isAi ? 'EXPLICIT' : 'NONE'
    });
    mediaIds.forEach((mediaId, index) => feedBody.set('attached_media[' + index + ']', JSON.stringify({ media_fbid: mediaId })));
    response = await fetch(graph(job.page_id + '/feed'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: feedBody
    });
  } else if (photos.length === 1) {
    const photo = photos[0], bytes = Buffer.from(photo.dataBase64 || '', 'base64');
    if (!bytes.length) throw new Error('A scheduled photo could not be read from the Phase 3 database.');
    const body = new FormData();
    body.set('source', new Blob([bytes], { type: photo.mimeType || 'image/jpeg' }), photo.mimeType === 'image/png' ? 'upload.png' : 'upload.jpg');
    body.set('caption', job.message || '');
    body.set('is_gen_ai', isAi ? 'true' : 'false');
    body.set('created_with_ai', isAi ? 'true' : 'false');
    body.set('edited_with_ai', 'false');
    body.set('provenance_type', isAi ? 'EXPLICIT' : 'NONE');
    body.set('access_token', job.pageAccessToken);
    response = await fetch(graph(job.page_id + '/photos'), { method: 'POST', body });
  } else {
    if (!job.image_url) throw new Error('The scheduled post has no saved photo data.');
    const body = new URLSearchParams({
      url: job.image_url,
      caption: job.message || '',
      is_gen_ai: isAi ? 'true' : 'false',
      created_with_ai: isAi ? 'true' : 'false',
      edited_with_ai: 'false',
      provenance_type: isAi ? 'EXPLICIT' : 'NONE',
      access_token: job.pageAccessToken
    });
    response = await fetch(graph(job.page_id + '/photos'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body
    });
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(describeMetaError(data, response.status));
  return String(data.post_id || data.id || '');
}

async function processOneJob(job) {
  let postId;
  try {
    postId = await publishToFacebook(job);
  } catch (error) {
    const retryCode = safePublishTransportRetryCode(error);
    const retryCount = Number(job.retry_count || 0);
    const causeCode = error?.cause?.code || error?.cause?.cause?.code || null;
    const message = (String(error?.message || error) + (causeCode && !retryCode ? ' (network code ' + causeCode + ')' : '')).slice(0, 1500);

    if (retryCode && retryCount < 3) {
      const retryAt = new Date(Date.now() + 15000 * (retryCount + 1)).toISOString();
      await complete(job, 'retry', {
        retryAt,
        error: 'Temporary Facebook connection failure (' + retryCode + '); automatic retry ' + (retryCount + 1) + '/3 scheduled.'
      });
      return;
    }

    await complete(job, 'failed', { error: message });
    return;
  }

  // Publishing succeeded. If the completion acknowledgement is lost, never retry
  // the Facebook publish: that could create a duplicate post.
  try {
    await complete(job, 'published', { postId });
  } catch (error) {
    console.error('[phase6-worker] Facebook publish succeeded but Phase 3 acknowledgement failed; leaving the job claimed to avoid duplicate publishing:', String(error?.message || error));
  }
}

async function processPass() {
  if (!WORKER_ENABLED) return;
  lastPollAt = new Date().toISOString();
  await phase3Request('/internal/phase6/heartbeat', {});
  const data = await phase3Request('/internal/phase6/claim', { limit: 500 });
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  if (!jobs.length) {
    lastSuccessAt = new Date().toISOString();
    lastError = null;
    return;
  }

  const pageGroups = groupJobsByPage(jobs, MAX_JOBS_PER_PAGE);
  const byCustomer = new Map();
  for (const group of pageGroups) {
    if (!byCustomer.has(group.customerId)) byCustomer.set(group.customerId, []);
    byCustomer.get(group.customerId).push(group);
  }

  const results = await Promise.all([...byCustomer.entries()].map(async ([customerId, groups]) => {
    const result = await runPageWorkers(groups, async group => {
      // A Page's posts are sequential; different Pages run concurrently.
      for (const job of group.jobs) await processOneJob(job);
    }, MAX_WORKERS_PER_CUSTOMER);
    return { customerId, ...result };
  }));

  lastSuccessAt = new Date().toISOString();
  lastError = null;
  console.info('[phase6-worker-pass]', JSON.stringify({
    claimedJobs: jobs.length,
    customers: results.length,
    pools: results.map(({ customerId, pageGroups, activeWorkerLimit }) => ({ customerId, pageGroups, activeWorkerLimit })),
    maxWorkersPerCustomer: MAX_WORKERS_PER_CUSTOMER,
    jobsPerPageWorker: MAX_JOBS_PER_PAGE
  }));
}

const server = http.createServer((req, res) => {
  // Keep the public worker URL and health URL useful even if a proxy adds a
  // trailing slash or query string. This service exposes status only.
  if (req.method === 'GET' || req.method === 'HEAD') {
    const status = JSON.stringify({
      ok: true,
      service: 'Facebook Bulk Scheduler Pro 3 Phase 6 Worker',
      mode: 'remote-single-database',
      enabled: WORKER_ENABLED,
      activePass,
      stopping,
      lastPollAt,
      lastSuccessAt,
      lastError
    });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : status);
    return;
  }
  res.writeHead(405, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: 'Method not allowed' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[phase6-worker] Ready; Phase 3 remains the only database owner. Worker enabled: ' + WORKER_ENABLED);
});

async function runLoop() {
  while (!stopping) {
    activePass = true;
    try {
      await processPass();
    } catch (error) {
      lastError = String(error?.message || error).slice(0, 500);
      console.error('[phase6-worker] Poll failed:', lastError);
    } finally {
      activePass = false;
    }
    if (stopping) break;
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

const heartbeatTimer = setInterval(() => {
  if (WORKER_ENABLED && !stopping) phase3Request('/internal/phase6/heartbeat', {}).catch(error => {
    lastError = String(error?.message || error).slice(0, 500);
  });
}, 10000);

const loopPromise = runLoop();

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log('[phase6-worker] ' + signal + ' received; stopping new claims and draining active work.');
  await loopPromise;
  clearInterval(heartbeatTimer);
  await new Promise(resolve => server.close(resolve));
  console.log('[phase6-worker] Shutdown complete.');
  process.exit(0);
}

process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });
