/**
 * Phase 2 tenant-isolation primitives.
 * These helpers deliberately fail closed: customer identity must come from the
 * authenticated server-side session, never from request body/query parameters.
 */
export function getCustomerId(req) {
  const id = req?.session?.customerAccount?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function requireCustomerAuth(req, res, next) {
  if (!getCustomerId(req)) {
    return res.status(401).json({ error: 'Sign in to your customer account first.' });
  }
  return next();
}

export function findCustomerPage(db, customerId, pageId) {
  if (typeof customerId !== 'string' || !customerId || typeof pageId !== 'string' || !pageId) return null;
  return db.prepare(
    'SELECT page_id, name FROM pages WHERE customer_id = ? AND page_id = ?'
  ).get(customerId, pageId) || null;
}

export function findCustomerJob(db, customerId, jobId) {
  if (typeof customerId !== 'string' || !customerId || typeof jobId !== 'string' || !jobId) return null;
  return db.prepare(
    'SELECT id, page_id, status FROM jobs WHERE customer_id = ? AND id = ?'
  ).get(customerId, jobId) || null;
}
