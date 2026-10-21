import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');

test('Phase 4 customer website has core navigation and workflow sections', () => {
  for (const id of ['home', 'details', 'manual', 'plans', 'signup']) {
    assert.match(html, new RegExp('id="' + id + '"'), 'missing customer section: ' + id);
  }
  for (const href of ['?open=software', '#plans', '#signup']) {
    assert.ok(html.includes('href="' + href + '"'), 'missing expected customer action: ' + href);
  }
});

test('Phase 4 customer website explains signup and plan activation are not live yet', () => {
  assert.match(html, /does not create or activate a real subscription/i);
  assert.match(html, /Email verification and plan activation need the production email\/payment services configured/i);
  assert.match(html, /payment\/UPI is intentionally not activated/i);
});

test('Phase 4 landing page is responsive and does not expose owner/admin navigation', () => {
  assert.match(html, /@media\s*\(max-width:\s*680px\)/);
  assert.doesNotMatch(html, /href=["'][^"']*owner-admin/i);
  assert.doesNotMatch(html, /Owner Admin Control Panel/i);
  assert.doesNotMatch(html, /Developer Panel/i);
});

test('customer/API server does not serve the future Phase 5 owner UI route', () => {
  assert.doesNotMatch(server, /app\.get\(['"]\/owner-admin['"]/);
});
