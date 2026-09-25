/**
 * Rate limiting and login lock-out, kept in the DATABASE (table rate_events) rather than in memory.
 * On serverless hosts (Vercel) every request may be handled by a different, short-lived copy of the server,
 * so in-memory counters would let an attacker simply spread guesses across copies. The database is shared.
 */
export function createLimiter(store) {
  return {
    /** Counts one event for `key`. Returns true (= refuse) when `key` already has `max` events inside `windowMs`. */
    async take(key, max, windowMs) {
      if ((await store.rateCount(key, windowMs)) >= max) return true;
      await store.rateHit(key);
      return false;
    },
    /** Is `key` at or over `max` events inside `windowMs`? (does not count anything) */
    async blocked(key, max, windowMs) { return (await store.rateCount(key, windowMs)) >= max; },
    /** Records one failure for `key`. */
    async fail(key) { await store.rateHit(key); },
    /** Forgets `key` (e.g. after a successful login). */
    async clear(key) { await store.rateClear(key); },
  };
}
