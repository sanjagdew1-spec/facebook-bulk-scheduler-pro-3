import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

test('Phase 2 frontend inline JavaScript parses without syntax errors', async () => {
  const html = await readFile(path.join(process.cwd(), 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0, 'index.html should contain the application script');
  for (const script of scripts) assert.doesNotThrow(() => new Function(script[1]));
});
