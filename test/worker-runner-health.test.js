import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('worker root and health endpoints return status instead of Not Found while safely disabled', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['worker-runner.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      PHASE3_API_URL: 'https://phase3.invalid',
      PHASE6_WORKER_SECRET: 'test-only-secret',
      PHASE6_ENABLED: 'false',
      PHASE6_POLL_INTERVAL_MS: '300000'
    },
    stdio: 'ignore'
  });

  try {
    let rootResponse;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (child.exitCode !== null) throw new Error('Worker process exited before opening its HTTP status endpoint.');
      try {
        rootResponse = await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(500) });
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    assert.ok(rootResponse, 'Worker root endpoint did not start.');
    assert.equal(rootResponse.status, 200);
    const root = await rootResponse.json();
    assert.equal(root.ok, true);
    assert.equal(root.enabled, false);
    assert.equal(root.mode, 'remote-single-database');

    const healthResponse = await fetch('http://127.0.0.1:' + port + '/health');
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.ok, true);
    assert.equal(health.enabled, false);
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
    });
  }
});
