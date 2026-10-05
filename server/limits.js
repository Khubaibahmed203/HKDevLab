/**
 * Rate limiting and login lock-out, kept in the DATABASE (table rate_events) rather than in memory.
 * On serverless hosts (Vercel) every request may be handled by a different, short-lived copy of the server,
 * so in-memory counters would let an attacker simply spread guesses across copies. The database is shared.
 *
 * ATOMIC ADMISSION. A request is admitted by RECORDING its hit first and only then counting — never "count, decide, then
 * record", which lets any number of concurrent requests all read the same old count and all be let through. The two statements
 * are separate auto-committed writes/reads, so the guarantee comes from the database, not from this process (it holds across
 * serverless copies, application instances and PostgreSQL's READ COMMITTED, with no lock and no transaction): a request counts
 * only AFTER its own hit committed, so the last-counting admitted request sees every other admitted hit (each of those committed
 * before that request's own count began, and an admitted hit is never removed). It is admitted only when that count — its own hit
 * included — is at most `max`, so at most `max` requests are ever admitted per window. A request over the limit deletes its own
 * hit again, so refusing leaves nothing behind (exactly as before) and a refused caller cannot extend its own lock-out.
 * Deliberately conservative under a burst larger than the remaining allowance: requests that overlap may each see the others'
 * transient hits and be refused together; never the other way round.
 */
export function createLimiter(store) {
  /** Claims one of `max` slots for `key` inside `windowMs`. Resolves to a slot — hand it to release() to give it back — or to
   *  null when the key is already full. An admitted slot STAYS recorded: for a login that is the failed-attempt record. */
  async function reserve(key, max, windowMs) {
    // Only a shortcut, never the decision: a key that is already full is refused with a single read and no write, so a flood against a
    // locked-out key costs what it always did. Admission below still has to pass the count that follows the request's own hit.
    if ((await store.rateCount(key, windowMs)) >= max) return null;
    const id = await store.rateHit(key);
    if ((await store.rateCount(key, windowMs)) <= max) return { id };
    await store.rateRelease(id);
    return null;
  }
  return {
    reserve,
    /** Gives back slots from reserve(); null (a refused reserve) is ignored, and releasing twice is harmless. */
    async release(...slots) { for (const slot of slots) if (slot) await store.rateRelease(slot.id); },
    /** Counts one event for `key`. Returns true (= refuse) when `key` already has `max` events inside `windowMs`. */
    async take(key, max, windowMs) { return (await reserve(key, max, windowMs)) === null; },
    /** Forgets `key` (e.g. after a successful login). */
    async clear(key) { await store.rateClear(key); },
  };
}
