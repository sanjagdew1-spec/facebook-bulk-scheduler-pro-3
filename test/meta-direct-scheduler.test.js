import test from 'node:test';
import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { registerMetaDirectScheduleRoute } from '../meta-direct-scheduler.js';

function makeResponse() {
  return {
    statusCode: 200, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    json(value) { this.body = value; return this; }
  };
}

test('Phase 7 schedules photo posts directly with the existing Page token and does not create Phase 3 jobs', async () => {
  const routes = new Map();
  const inserted = [];
  const sqlCalls = [];
  const db = {
    exec() {},
    prepare(sql) {
      sqlCalls.push(sql);
      return {
        get(...args) {
          if (sql.includes('FROM meta_scheduled_posts')) return null;
          if (sql.includes('FROM customer_pages')) return { name: 'Page One', access_token: 'encrypted-page-token' };
          throw new Error('Unexpected query: ' + sql);
        },
        run(...args) { inserted.push({ sql, args }); return { changes: 1 }; }
      };
    }
  };
  const app = { post(path, ...handlers) { routes.set(path, handlers); } };
  registerMetaDirectScheduleRoute(app, {
    db,
    requireTrustedOrigin(_req, _res, next) { next(); },
    requireAuth(_req, _res, next) { next(); },
    requirePlanAccess(_req, _res, next) { next(); },
    enforcePlanLimits() { return true; },
    decryptToken(value) { assert.equal(value, 'encrypted-page-token'); return 'existing-page-token'; },
    graph(path) { return 'https://graph.test/v26.0/' + path; },
    now() { return new Date().toISOString(); }
  });

  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith('/page-1/photos')) {
      return { ok: true, status: 200, async json() { return { id: 'photo-1' }; } };
    }
    if (String(url).endsWith('/page-1/feed')) {
      return { ok: true, status: 200, async json() { return { id: 'page-1_post-1' }; } };
    }
    throw new Error('Unexpected Meta request: ' + url);
  };
  try {
    const handler = routes.get('/api/meta-schedule').at(-1);
    const req = {
      body: {
        requestId: 'batch-test-0001',
        posts: [{
          clientPostId: 'post-slot-0001',
          message: 'Hello from Phase 7',
          images: [{ imageData: 'data:image/jpeg;base64,aGVsbG8=', imageMimeType: 'image/jpeg' }],
          pageSchedules: [{ pageId: 'page-1', scheduledAt: new Date(Date.now() + 20 * 60 * 1000).toISOString() }]
        }]
      },
      session: { customerAccount: { id: 'customer-1' }, fbUser: { id: 'facebook-user-1' } },
      planAccess: { unlimited: true, role: 'developer' }
    };
    const res = makeResponse();
    await handler(req, res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.scheduledCount, 1);
    assert.equal(res.body.results[0].metaPostId, 'page-1_post-1');
    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /page-1\/photos$/);
    assert.equal(requests[0].options.body.get('access_token'), 'existing-page-token');
    assert.equal(requests[0].options.body.get('published'), 'false');
    assert.equal(requests[0].options.body.get('temporary'), 'true');
    assert.match(requests[1].url, /page-1\/feed$/);
    const feed = requests[1].options.body;
    assert.equal(feed.get('published'), 'false');
    assert.equal(feed.get('unpublished_content_type'), 'SCHEDULED');
    assert.equal(feed.get('access_token'), 'existing-page-token');
    assert.equal(JSON.parse(feed.get('attached_media[0]')).media_fbid, 'photo-1');
    assert.equal(inserted.length, 1);
    assert.match(inserted[0].sql, /INSERT INTO meta_scheduled_posts/);
    assert.equal(sqlCalls.some(sql => /INSERT INTO jobs/.test(sql)), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Phase 7 rejects a schedule less than ten minutes in the future before contacting Meta', async () => {
  const routes = new Map();
  const db = { exec() {}, prepare() { throw new Error('Database should not be queried'); } };
  const app = { post(path, ...handlers) { routes.set(path, handlers); } };
  registerMetaDirectScheduleRoute(app, {
    db,
    requireTrustedOrigin(_req, _res, next) { next(); },
    requireAuth(_req, _res, next) { next(); },
    requirePlanAccess(_req, _res, next) { next(); },
    enforcePlanLimits() { return true; },
    decryptToken() { throw new Error('Token should not be read'); },
    graph(path) { return 'https://graph.test/' + path; },
    now() { return new Date().toISOString(); }
  });
  const handler = routes.get('/api/meta-schedule').at(-1);
  const req = {
    body: {
      requestId: 'batch-test-0002',
      posts: [{
        clientPostId: 'post-slot-0002',
        images: [{ imageData: 'data:image/jpeg;base64,aGVsbG8=', imageMimeType: 'image/jpeg' }],
        pageSchedules: [{ pageId: 'page-1', scheduledAt: new Date(Date.now() + 60_000).toISOString() }]
      }]
    },
    session: { customerAccount: { id: 'customer-1' }, fbUser: { id: 'facebook-user-1' } },
    planAccess: { unlimited: true, role: 'developer' }
  };
  const res = makeResponse();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /at least 10 minutes/);
});


test('Direct Facebook scheduling distributes 70 Page-post tasks across a maximum of ten concurrent workers', async () => {
  const routes = new Map();
  const inserted = [];
  const db = {
    exec() {},
    prepare(sql) {
      return {
        get(...args) {
          if (sql.includes('FROM meta_scheduled_posts')) return null;
          if (sql.includes('FROM customer_pages')) return { name: 'Page ' + args[2], access_token: 'encrypted-page-token' };
          throw new Error('Unexpected query: ' + sql);
        },
        run(...args) { inserted.push({ sql, args }); return { changes: 1 }; }
      };
    }
  };
  const app = { post(path, ...handlers) { routes.set(path, handlers); } };
  registerMetaDirectScheduleRoute(app, {
    db,
    requireTrustedOrigin(_req, _res, next) { next(); },
    requireAuth(_req, _res, next) { next(); },
    requirePlanAccess(_req, _res, next) { next(); },
    enforcePlanLimits() { return true; },
    decryptToken() { return 'existing-page-token'; },
    graph(path) { return 'https://graph.test/v26.0/' + path; },
    now() { return new Date().toISOString(); }
  });

  const originalFetch = globalThis.fetch;
  let activeRequests = 0;
  let maxActiveRequests = 0;
  let requestId = 0;
  globalThis.fetch = async (url) => {
    activeRequests++;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    const current = ++requestId;
    await new Promise(resolve => setTimeout(resolve, 3));
    activeRequests--;
    if (String(url).endsWith('/photos')) {
      return { ok: true, status: 200, async json() { return { id: 'photo-' + current }; } };
    }
    if (String(url).endsWith('/feed')) {
      return { ok: true, status: 200, async json() { return { id: 'scheduled-' + current }; } };
    }
    throw new Error('Unexpected Meta request: ' + url);
  };

  try {
    const posts = Array.from({ length: 10 }, (_, slot) => ({
      clientPostId: 'page-post-slot-' + String(slot).padStart(4, '0'),
      message: 'Post ' + slot,
      images: [{ imageData: 'data:image/jpeg;base64,aGVsbG8=', imageMimeType: 'image/jpeg' }],
      pageSchedules: Array.from({ length: 7 }, (_, page) => ({
        pageId: 'page-' + (page + 1),
        scheduledAt: new Date(Date.now() + 20 * 60 * 1000 + slot * 60_000).toISOString()
      }))
    }));
    const req = {
      body: { requestId: 'batch-test-0070', posts },
      session: { customerAccount: { id: 'customer-1' }, fbUser: { id: 'facebook-user-1' } },
      planAccess: { unlimited: true, role: 'developer' }
    };
    const res = makeResponse();
    await routes.get('/api/meta-schedule').at(-1)(req, res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.requestedCount, 70);
    assert.equal(res.body.scheduledCount, 70);
    assert.equal(inserted.length, 70);
    assert.equal(maxActiveRequests, 10);
    assert.ok(res.body.results.every(result => result.status === 'scheduled'));
    assert.equal(new Set(res.body.results.map(result => result.pageId + ':' + result.scheduledAt)).size, 70);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('chunked direct scheduling stages uploads first and refuses commit until every chunk arrives', async () => {
  const routes = new Map();
  const db = new Database(':memory:');
  const app = { post(path, ...handlers) { routes.set(path, handlers); } };
  registerMetaDirectScheduleRoute(app, {
    db,
    requireTrustedOrigin(_req, _res, next) { next(); },
    requireAuth(_req, _res, next) { next(); },
    requirePlanAccess(_req, _res, next) { next(); },
    enforcePlanLimits() { return true; },
    decryptToken() { return 'existing-page-token'; },
    graph(path) { return 'https://graph.test/v26.0/' + path; },
    now() { return new Date().toISOString(); }
  });
  const baseReq = {
    session: { customerAccount: { id: 'customer-stage' }, fbUser: { id: 'facebook-user-stage' } },
    planAccess: { unlimited: true, role: 'developer' }
  };
  const post = {
    clientPostId: 'stage-post-0001',
    message: 'Staged post',
    images: [{ imageData: 'data:image/jpeg;base64,aGVsbG8=', imageMimeType: 'image/jpeg' }],
    pageSchedules: [{ pageId: 'page-stage', scheduledAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() }]
  };
  const originalFetch = globalThis.fetch;
  let metaCalls = 0;
  globalThis.fetch = async () => { metaCalls++; throw new Error('Meta must not be called before all chunks arrive'); };
  try {
    const stageHandler = routes.get('/api/meta-schedule/chunk').at(-1);
    const stageRes = makeResponse();
    await stageHandler({ ...baseReq, body: { requestId: 'stage-batch-0001', chunkIndex: 0, totalChunks: 2, totalPosts: 2, posts: [post] } }, stageRes);
    assert.equal(stageRes.statusCode, 200);
    assert.equal(stageRes.body.received, true);
    assert.equal(db.prepare('SELECT received_chunks FROM meta_schedule_upload_batches WHERE request_id=?').get('stage-batch-0001').received_chunks, 1);

    const commitRes = makeResponse();
    await routes.get('/api/meta-schedule/commit').at(-1)({ ...baseReq, body: { requestId: 'stage-batch-0001' } }, commitRes);
    assert.equal(commitRes.statusCode, 409);
    assert.match(commitRes.body.error, /finish uploading before scheduling starts/);
    assert.equal(metaCalls, 0);

    const abortRes = makeResponse();
    await routes.get('/api/meta-schedule/abort').at(-1)({ ...baseReq, body: { requestId: 'stage-batch-0001' } }, abortRes);
    assert.equal(abortRes.statusCode, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM meta_schedule_upload_batches').get().count, 0);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});
