export const DEFAULT_PAGE_WORKER_JOB_LIMIT = 10;

export function groupJobsByPage(jobs, maxJobsPerWorker = DEFAULT_PAGE_WORKER_JOB_LIMIT) {
  const limit = Math.max(1, Math.floor(Number(maxJobsPerWorker) || DEFAULT_PAGE_WORKER_JOB_LIMIT));
  const groups = new Map();
  for (const job of jobs || []) {
    const customerId = String(job.customer_id || '');
    const pageId = String(job.page_id || '');
    // A Page ID may appear under multiple customer accounts; keep their queues isolated.
    const key = `${customerId}::${pageId}`;
    if (!groups.has(key)) groups.set(key, { key, customerId, pageId, jobs: [] });
    const group = groups.get(key);
    if (group.jobs.length < limit) group.jobs.push(job);
  }
  return [...groups.values()];
}

export async function runPageWorkers(groups, worker, maxWorkers = 10) {
  const queue = [...(groups || [])];
  const concurrency = Math.max(1, Math.min(queue.length || 1, Math.floor(Number(maxWorkers) || 1)));
  let next = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (next < queue.length) {
      const index = next++;
      await worker(queue[index]);
    }
  });
  const results = await Promise.allSettled(runners);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return { pageGroups: queue.length, activeWorkerLimit: concurrency };
}
