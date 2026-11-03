import test from 'node:test';
import assert from 'node:assert/strict';
import { groupJobsByPage, runPageWorkers } from '../page-worker-scheduler.js';

function job(id, customer_id, user_id, page_id) {
  return { id, customer_id, user_id, page_id };
}

test('creates isolated worker queues for the same Facebook Page when owned by different customers', () => {
  const groups = groupJobsByPage([
    job('a1', 'customer-a', 'fb-a', 'page-1'),
    job('a2', 'customer-a', 'fb-a', 'page-1'),
    job('b1', 'customer-b', 'fb-b', 'page-1'),
    job('a3', 'customer-a', 'fb-a', 'page-2')
  ]);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map(group => group.jobs.map(item => item.id)), [['a1', 'a2'], ['b1'], ['a3']]);
  assert.deepEqual(groups.map(group => group.customerId), ['customer-a', 'customer-b', 'customer-a']);
});

test('a page worker receives no more than ten posts in one batch', () => {
  const jobs = Array.from({ length: 35 }, (_, index) => job(String(index), 'customer-a', 'fb-a', 'page-1'));
  const groups = groupJobsByPage(jobs, 10);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].jobs.length, 10);
  assert.deepEqual(groups[0].jobs.map(item => item.id), ['0','1','2','3','4','5','6','7','8','9']);
});

test('uses one active worker per page when five or ten pages are due', async () => {
  for (const pageCount of [5, 10]) {
    const groups = groupJobsByPage(Array.from({ length: pageCount }, (_, index) => job(String(index), 'customer-a', 'fb-a', 'page-' + index)));
    let active = 0;
    let peak = 0;
    await runPageWorkers(groups, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
    }, 10);
    assert.equal(peak, pageCount);
  }
});

test('caps active page workers without mixing jobs from the same page', async () => {
  const groups = groupJobsByPage(Array.from({ length: 18 }, (_, index) => job(String(index), 'customer-a', 'fb-a', 'page-' + index)));
  let active = 0;
  let peak = 0;
  await runPageWorkers(groups, async group => {
    active++;
    peak = Math.max(peak, active);
    assert.equal(new Set(group.jobs.map(item => item.page_id)).size, 1);
    await new Promise(resolve => setTimeout(resolve, 3));
    active--;
  }, 10);
  assert.equal(peak, 10);
});


test('each customer gets an independent pool of up to ten Page workers', async () => {
  const customers = ['customer-a', 'customer-b', 'customer-c'];
  const peaks = new Map(customers.map(id => [id, 0]));
  await Promise.all(customers.map(async customerId => {
    const groups = groupJobsByPage(Array.from({ length: 10 }, (_, index) => job(customerId + '-' + index, customerId, 'fb-' + customerId, 'page-' + index)));
    let active = 0;
    await runPageWorkers(groups, async () => {
      active++;
      peaks.set(customerId, Math.max(peaks.get(customerId), active));
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
    }, 10);
  }));
  for (const customerId of customers) assert.equal(peaks.get(customerId), 10);
});


test('waits for each post absolute scheduled time instead of carrying earlier processing delay forward', async () => {
  const target = Date.parse('2030-01-01T11:11:00.000Z');
  let clock = target - 2500;
  const waits = [];
  await (await import('../page-worker-scheduler.js')).waitUntilScheduled('2030-01-01T11:11:00.000Z', {
    now: () => clock,
    sleep: async ms => { waits.push(ms); clock += ms; }
  });
  assert.equal(clock, target);
  assert.deepEqual(waits, [1000, 1000, 500]);
});

test('does not wait when a scheduled post time has already arrived', async () => {
  let slept = false;
  await (await import('../page-worker-scheduler.js')).waitUntilScheduled('2020-01-01T00:00:00.000Z', {
    now: () => Date.parse('2030-01-01T00:00:00.000Z'),
    sleep: async () => { slept = true; }
  });
  assert.equal(slept, false);
});
