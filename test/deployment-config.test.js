import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Docker image includes every local JavaScript module required by server.js', async () => {
  const [server, dockerfile] = await Promise.all([
    readFile(new URL('../server.js', import.meta.url), 'utf8'),
    readFile(new URL('../Dockerfile', import.meta.url), 'utf8')
  ]);
  const localImports = [...server.matchAll(/from\s+['"]\.\/([^'"]+\.js)['"]/g)].map(match => match[1]);
  assert.ok(localImports.length > 0, 'server should import local modules');
  assert.match(dockerfile, /^COPY \*\.js \.\/$/m, 'Dockerfile must copy root JavaScript modules');
  for (const moduleName of localImports) {
    const moduleSource = await readFile(new URL('../' + moduleName, import.meta.url), 'utf8');
    assert.ok(moduleSource.length > 0, moduleName + ' must exist and not be empty');
  }
});

test('Phase 2 free Render blueprint stays separate and explicitly uses free resources', async () => {
  const blueprint = await readFile(new URL('../render.phase2-free.yaml', import.meta.url), 'utf8');
  assert.match(blueprint, /name: facebook-bulk-scheduler-pro-3-p2-api/);
  assert.match(blueprint, /name: facebook-bulk-scheduler-pro-3-p2-web/);
  assert.match(blueprint, /plan: free/);
  assert.match(blueprint, /branch: phase-2\/customer-service-system/);
  assert.doesNotMatch(blueprint, /plan: (starter|standard|pro|pro_plus|pro_max|pro_ultra)/);
});


test('Phase 2 static site build publishes the policy pages and points at the isolated API', async () => {
  const [blueprint, html] = await Promise.all([
    readFile(new URL('../render.phase2-free.yaml', import.meta.url), 'utf8'),
    readFile(new URL('../index.html', import.meta.url), 'utf8')
  ]);
  assert.match(blueprint, /cp index\.html privacy-policy\.html data-deletion\.html 404\.html dist\//);
  assert.match(blueprint, /staticPublishPath: dist/);
  assert.match(html, /const API = 'https:\/\/facebook-bulk-scheduler-pro-3-p2-api\.onrender\.com';/);
  assert.match(html, /href="privacy-policy\.html"/);
  assert.match(html, /href="data-deletion\.html"/);
});
