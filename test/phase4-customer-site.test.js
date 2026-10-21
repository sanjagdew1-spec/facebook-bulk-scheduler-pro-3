import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');

test('Phase 4 customer website has dedicated Details, Manual, Plans and Get Started views', () => {
  for (const id of ['home', 'details', 'manual', 'plans', 'signup']) {
    assert.match(html, new RegExp('id="' + id + '"'), 'missing customer section: ' + id);
  }
  for (const view of ['details', 'manual', 'plans']) {
    assert.ok(html.includes('data-view-link="' + view + '"'), 'missing navigation item: ' + view);
  }
  assert.match(html, /location\.replace\("scheduler\.html"\)/);
  assert.match(html, /document\.getElementById\('signup'\)\.hidden=view!=='signup'/);
  assert.match(html, /document\.getElementById\('cta-section'\)\.hidden=true/);
  assert.match(html, /href="\?view=plans"/);
  assert.match(html, /href="\?open=software"/);
});

test('Phase 4 website explains signup and plan activation are not live yet', () => {
  assert.match(html, /Email verification and plan activation need the production email\/payment services configured/i);
  assert.match(html, /payment\/UPI is intentionally not activated/i);
  assert.match(html, /no account or demo has been created/i);
});

test('Phase 4 landing page is responsive and does not expose owner/admin navigation', () => {
  assert.match(html, /@media\s*\(max-width:\s*680px\)/);
  assert.match(html, /\.nav a\{display:inline-flex/);
  assert.doesNotMatch(html, /href=["'][^"']*owner-admin/i);
  assert.doesNotMatch(html, /Owner Admin Control Panel/i);
  assert.doesNotMatch(html, /Developer Panel/i);
});

test('customer/API server does not serve the future Phase 5 owner UI route', () => {
  assert.doesNotMatch(server, /app\.get\(['"]\/owner-admin['"]/);
});
