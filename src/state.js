/**
 * Change detection across poll cycles.
 *
 * The watcher keeps running after a hit, so it must alert only when the set of
 * matching seats actually changes - otherwise the same open pair would notify
 * every 30 seconds.
 */

/** Stable, order-independent fingerprint of a set of matching runs. */
export function signature(runs) {
  return runs
    .map((r) => `${r.row}:${[...r.seats].sort().join(',')}`)
    .sort()
    .join('|');
}

export class MatchTracker {
  #previous = new Map();

  /**
   * Classify this cycle's result for one showtime.
   *
   * - `appeared`  seats match and the set differs from last time -> alert
   * - `gone`      seats matched before and now do not -> quiet note
   * - `unchanged` nothing to say
   */
  update(key, runs) {
    const sig = signature(runs);
    const prev = this.#previous.get(key) ?? '';
    this.#previous.set(key, sig);

    if (sig && sig !== prev) return 'appeared';
    if (!sig && prev) return 'gone';
    return 'unchanged';
  }

  /**
   * Drop one showtime's history.
   *
   * Used when a showtime is removed, paused, or has its rule changed: the next
   * check should be treated as a first sighting, so seats that still match are
   * alerted on again rather than being silently suppressed.
   */
  forget(key) {
    this.#previous.delete(key);
  }

  /** Drop all history — used when the global rule changes. */
  reset() {
    this.#previous.clear();
  }
}
