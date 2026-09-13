import { appleReady, googleReady } from '../config.js';
import { pushPassUpdate } from './applePush.js';
import { syncObject } from './googleWallet.js';

/**
 * Fans a card change out to both wallets.
 *
 * Deliberately fire-and-forget: the barista must see "נוקב!" immediately, and a
 * slow APNs or Google call should never hold up the queue. Failures are logged
 * and the next punch re-syncs anyway, because both updates send full state.
 */
export function syncWallets(customer, { await: shouldAwait = false } = {}) {
  const jobs = [];
  if (appleReady) jobs.push(pushPassUpdate(customer.public_id));
  if (googleReady) jobs.push(syncObject(customer));

  const all = Promise.allSettled(jobs).then((results) => {
    for (const r of results) {
      if (r.status === 'rejected') console.warn('[sync] עדכון ארנק נכשל:', r.reason?.message || r.reason);
    }
    return results;
  });

  if (shouldAwait) return all;
  all.catch(() => {});
  return Promise.resolve(null);
}
