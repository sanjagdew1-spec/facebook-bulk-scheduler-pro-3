import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE customer_accounts (
      id TEXT PRIMARY KEY, email_normalized TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE customer_pages (
      customer_id TEXT NOT NULL, facebook_user_id TEXT NOT NULL,
      page_id TEXT NOT NULL, name TEXT NOT NULL, access_token TEXT NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY(customer_id, page_id)
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, page_id TEXT NOT NULL,
      page_name TEXT NOT NULL, message TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '', scheduled_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled', created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, customer_id TEXT
    );
    CREATE TABLE job_images (
      job_id TEXT NOT NULL, position INTEGER NOT NULL,
      image_data BLOB NOT NULL, image_mime_type TEXT NOT NULL,
      PRIMARY KEY(job_id, position)
    );
  `);
  return db;
}

test('SQLite tenant scope isolates same Facebook Page ID across two customer accounts', () => {
  const db = makeDb();
  db.prepare('INSERT INTO customer_accounts(id,email_normalized,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run('cust-a','a@example.test','hash-a','now','now');
  db.prepare('INSERT INTO customer_accounts(id,email_normalized,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run('cust-b','b@example.test','hash-b','now','now');
  const savePage = db.prepare('INSERT INTO customer_pages(customer_id,facebook_user_id,page_id,name,access_token,updated_at) VALUES(?,?,?,?,?,?)');
  savePage.run('cust-a','fb-1','page-1','Customer A Page','enc-token-a','now');
  savePage.run('cust-b','fb-1','page-1','Customer B Page','enc-token-b','now');

  const pagesA = db.prepare('SELECT page_id,name,access_token FROM customer_pages WHERE customer_id=? AND facebook_user_id=? AND page_id=?').all('cust-a','fb-1','page-1');
  const pagesB = db.prepare('SELECT page_id,name,access_token FROM customer_pages WHERE customer_id=? AND facebook_user_id=? AND page_id=?').all('cust-b','fb-1','page-1');
  assert.deepEqual(pagesA.map(p => p.name), ['Customer A Page']);
  assert.deepEqual(pagesA.map(p => p.access_token), ['enc-token-a']);
  assert.deepEqual(pagesB.map(p => p.name), ['Customer B Page']);
  assert.deepEqual(pagesB.map(p => p.access_token), ['enc-token-b']);
  db.close();
});

test('SQLite job history, deletion, and publisher token lookup are customer-scoped', () => {
  const db = makeDb();
  const insert = db.prepare('INSERT INTO jobs(id,user_id,page_id,page_name,message,scheduled_at,status,created_at,updated_at,customer_id) VALUES(?,?,?,?,?,?,?,?,?,?)');
  insert.run('job-a','fb-1','page-1','A Page','A post','2030-01-01T00:00:00.000Z','scheduled','now','now','cust-a');
  insert.run('job-b','fb-1','page-1','B Page','B post','2030-01-01T00:00:00.000Z','scheduled','now','now','cust-b');

  const historyA = db.prepare('SELECT id,message FROM jobs WHERE customer_id=? AND user_id=? ORDER BY scheduled_at DESC LIMIT 500').all('cust-a','fb-1');
  assert.deepEqual(historyA.map(j => j.id), ['job-a']);
  const deleteA = db.prepare("DELETE FROM jobs WHERE id=? AND customer_id=? AND user_id=? AND status='scheduled'").run('job-b','cust-a','fb-1');
  assert.equal(deleteA.changes, 0);
  assert.equal(db.prepare('SELECT id FROM jobs WHERE id=?').get('job-b').id, 'job-b');

  db.prepare('INSERT INTO customer_pages(customer_id,facebook_user_id,page_id,name,access_token,updated_at) VALUES(?,?,?,?,?,?)')
    .run('cust-a','fb-1','page-1','A Page','enc-token-a','now');
  db.prepare('INSERT INTO customer_pages(customer_id,facebook_user_id,page_id,name,access_token,updated_at) VALUES(?,?,?,?,?,?)')
    .run('cust-b','fb-1','page-1','B Page','enc-token-b','now');
  const pageTokenForA = db.prepare('SELECT access_token FROM customer_pages WHERE customer_id=? AND facebook_user_id=? AND page_id=?').get('cust-a','fb-1','page-1');
  assert.equal(pageTokenForA.access_token, 'enc-token-a');
  db.close();
});
