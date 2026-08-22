/**
 * Run `task` over `items` with at most `limit` running at once.
 *
 * A fixed set of workers pull from a shared queue, so a slow item never leaves
 * the other workers idle — which is what would happen with fixed-size batches
 * (`Promise.all` over chunks), where every chunk waits for its slowest member.
 *
 * Results come back in the same order as `items`, each entry either
 * `{ ok: true, value }` or `{ ok: false, error }`. One failing item never
 * rejects the whole run, so a single bad showtime cannot abort a poll cycle.
 */
export async function pool(items, limit, task) {
  const list = [...items];
  const results = new Array(list.length);
  let cursor = 0;

  const workerCount = Math.max(1, Math.min(limit, list.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= list.length) return;
      try {
        results[index] = { ok: true, value: await task(list[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });

  await Promise.all(workers);
  return results;
}
