import { EventEmitter } from 'node:events';

import {
  parseTicketUrl,
  ticketUrl,
  fetchSeatLayout,
  fetchAvailability,
  fetchShowtimeMeta,
  HttpError,
} from './api.js';
import { buildSeatIndex, matchSeats } from './match.js';
import { MatchTracker } from './state.js';
import { macNotify } from './notify.js';
import { pool } from './pool.js';

/** Per-target retry backoff after a failed poll, in ms. Resets on success. */
const BACKOFF_STEPS = [30_000, 60_000, 120_000, 300_000];
const JITTER_MS = 3_000;

/**
 * Default simultaneous requests to Cineplex.
 *
 * Six is about what a browser opens against one host, and it keeps a cycle
 * roughly one request deep regardless of how many showtimes are watched.
 */
const DEFAULT_CONCURRENCY = 6;
const MAX_CONCURRENCY = 16;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The crawl engine.
 *
 * Owns the target list and the poll loop, and can be mutated while running so
 * the web UI can add or remove showtimes without a restart.
 *
 * Showtimes are polled concurrently through a bounded worker pool. There is no
 * global lock: separate targets touch disjoint state (their own fields, and a
 * tracker entry keyed by target), so the only genuine hazard is two overlapping
 * checks of the *same* showtime — which `#checkTarget` prevents by joining the
 * in-flight promise instead of starting a second request.
 *
 * Emits: `target` (one showtime checked), `alert` (new matching seats),
 * `cycle` (a full pass finished), `scheduled`, `log`, `error`.
 */
export class Watcher extends EventEmitter {
  #targets = new Map();
  /** Keys reserved by an in-progress addTarget, so parallel adds can't collide. */
  #adding = new Set();
  #tracker = new MatchTracker();
  #running = false;
  #abort = null;
  #alerts = 0;
  #startedAt = null;
  #nextCycleAt = null;
  #lastCycleMs = null;

  constructor({ pollSeconds = 30, want = {}, notify = {}, maxConcurrency } = {}) {
    super();
    this.pollSeconds = pollSeconds;
    this.want = want;
    this.notify = notify;
    this.maxConcurrency = clampConcurrency(maxConcurrency);
  }

  get alerts() {
    return this.#alerts;
  }
  get startedAt() {
    return this.#startedAt;
  }
  get running() {
    return this.#running;
  }
  /** Epoch ms when the next poll is due, or null when idle. */
  get nextCycleAt() {
    return this.#nextCycleAt;
  }

  #log(level, message) {
    this.emit('log', { level, message, at: new Date().toISOString() });
  }

  /**
   * Validate a showtime and start crawling it.
   *
   * Accepts either a ticketing URL or a bare locationId/showtimeId pair. Fetches
   * the seat layout up front, which doubles as validation: a bad id fails here
   * with a clear message instead of silently never matching.
   */
  async addTarget({ url, locationId, showtimeId, want = null, check = true }) {
    let resolved;
    if (url) {
      resolved = parseTicketUrl(url);
    } else {
      // Validate before building a URL: String(undefined) is "undefined", which
      // is truthy, so a bare presence check here would let bad ids straight
      // through to the API and surface as a confusing HTTP 400.
      const loc = String(locationId ?? '').trim();
      const show = String(showtimeId ?? '').trim();
      if (!loc || !show) throw new Error('A location ID and a showtime ID are both required.');
      if (!/^[0-9]+$/.test(loc) || !/^[0-9]+$/.test(show)) {
        throw new Error('Location and showtime IDs must be numbers.');
      }
      resolved = { url: ticketUrl(loc, show), locationId: loc, showtimeId: show };
    }

    const key = `${resolved.locationId}/${resolved.showtimeId}`;
    // Reserve the key before the await below: adds run concurrently, so two
    // requests for the same showtime would otherwise both pass this check.
    if (this.#targets.has(key) || this.#adding.has(key)) {
      throw new Error(
        `Showtime ${resolved.showtimeId} at location ${resolved.locationId} is already being watched.`
      );
    }
    this.#adding.add(key);

    const target = {
      key,
      url: resolved.url,
      locationId: resolved.locationId,
      showtimeId: resolved.showtimeId,
      want,
      paused: false,
      retired: false,
      seatIndex: null,
      movie: null,
      theatre: null,
      showDate: null,
      startTime: null,
      startTimeUtc: null,
      rows: [],
      failures: 0,
      skipUntil: 0,
      error: null,
      lastChecked: null,
      lastResult: null,
      inFlight: null,
      addedAt: new Date().toISOString(),
    };

    try {
      await warmup(target);
    } catch (err) {
      // Turn transport errors into something a person can act on: the raw
      // HttpError message carries the internal API URL, which is noise here.
      if (err instanceof HttpError && err.status === 404) {
        throw new Error(
          `No showtime ${resolved.showtimeId} found at location ${resolved.locationId}. Check both IDs.`
        );
      }
      if (err instanceof HttpError) {
        throw new Error(`Cineplex returned HTTP ${err.status} for that showtime.`);
      }
      throw new Error(`Could not reach Cineplex: ${err.message}`);
    } finally {
      this.#adding.delete(key);
    }

    if (hasStarted(target)) {
      const err = new Error(
        `That showtime already started (${formatLocal(target.startTime)}). Nothing left to watch.`
      );
      // Distinguishable from a genuine failure: on restore these are pruned
      // rather than reported as errors on every startup.
      err.code = 'expired';
      err.startTime = target.startTime;
      err.movie = target.movie;
      throw err;
    }

    this.#targets.set(key, target);
    this.#log('info', `Watching ${target.movie ?? 'showtime ' + target.showtimeId} (${key})`);

    // Check immediately so the UI shows real data without waiting a full cycle.
    // Callers that are about to run a cycle anyway pass `check: false`, so the
    // first real check is not swallowed as an "unchanged" repeat.
    if (check) await this.#checkTarget(target);
    return this.describeTarget(target);
  }

  /**
   * Add several showtimes at once.
   *
   * Lookups run through the same bounded pool as polling, so adding ten
   * showtimes costs roughly one round trip rather than ten. Each is attempted
   * independently, so one bad ID cannot discard the rest.
   */
  async addTargets(items) {
    const settled = await pool(items, this.maxConcurrency, (item) => this.addTarget(item));

    const added = [];
    const failed = [];
    settled.forEach((outcome, i) => {
      if (outcome.ok) added.push(outcome.value);
      else {
        failed.push({
          locationId: items[i].locationId ?? null,
          showtimeId: items[i].showtimeId ?? items[i].url ?? null,
          error: outcome.error.message,
          code: outcome.error.code ?? null,
          movie: outcome.error.movie ?? null,
          startTime: outcome.error.startTime ?? null,
        });
      }
    });
    return { added, failed };
  }

  removeTarget(key) {
    const target = this.#targets.get(key);
    if (!target) throw new Error(`Not watching ${key}.`);
    this.#targets.delete(key);
    this.#tracker.forget(key);
    this.#log('info', `Stopped watching ${target.movie ?? key}`);
    return true;
  }

  setPaused(key, paused) {
    const target = this.#targets.get(key);
    if (!target) throw new Error(`Not watching ${key}.`);
    target.paused = Boolean(paused);
    // Forget history so resuming re-alerts on seats that are still free.
    if (target.paused) this.#tracker.forget(key);
    return this.describeTarget(target);
  }

  /** Replace a single showtime's rule. `null` falls back to the global one. */
  async setTargetWant(key, want) {
    const target = this.#targets.get(key);
    if (!target) throw new Error(`Not watching ${key}.`);
    target.want = want && Object.keys(want).length ? want : null;
    this.#tracker.forget(key); // the rule changed, so matches are a fresh slate
    await this.#checkTarget(target);
    return this.describeTarget(target);
  }

  updateSettings({ pollSeconds, want, notify, maxConcurrency }) {
    if (pollSeconds != null) this.pollSeconds = Math.max(5, Number(pollSeconds));
    if (maxConcurrency != null) this.maxConcurrency = clampConcurrency(maxConcurrency);
    if (want) {
      this.want = want;
      this.#tracker.reset(); // global rule changed — re-evaluate everything
    }
    if (notify) this.notify = { ...this.notify, ...notify };
    return this.getSettings();
  }

  getSettings() {
    return {
      pollSeconds: this.pollSeconds,
      want: this.want,
      notify: this.notify,
      maxConcurrency: this.maxConcurrency,
    };
  }

  /** Effective rule for a target: its own override, else the global rule. */
  effectiveWant(target) {
    return target.want && Object.keys(target.want).length ? target.want : this.want;
  }

  describeTarget(target) {
    return {
      key: target.key,
      url: target.url,
      locationId: target.locationId,
      showtimeId: target.showtimeId,
      movie: target.movie,
      theatre: target.theatre,
      showDate: target.showDate,
      startTime: target.startTime,
      startTimeUtc: target.startTimeUtc,
      expired: hasStarted(target),
      rows: target.rows,
      seatCount: target.seatIndex ? target.seatIndex.size : 0,
      want: target.want,
      effectiveWant: this.effectiveWant(target),
      paused: target.paused,
      retired: target.retired,
      error: target.error,
      lastChecked: target.lastChecked,
      result: target.lastResult,
      addedAt: target.addedAt,
    };
  }

  getState() {
    return {
      running: this.#running,
      startedAt: this.#startedAt,
      nextCycleAt: this.#nextCycleAt,
      pollSeconds: this.pollSeconds,
      lastCycleMs: this.#lastCycleMs,
      alerts: this.#alerts,
      settings: this.getSettings(),
      targets: [...this.#targets.values()].map((t) => this.describeTarget(t)),
    };
  }

  /** Serialisable form for ConfigStore. */
  toConfig() {
    return {
      pollSeconds: this.pollSeconds,
      maxConcurrency: this.maxConcurrency,
      want: this.want,
      notify: this.notify,
      targets: [...this.#targets.values()].map((t) => ({
        url: t.url,
        want: t.want,
        paused: t.paused,
      })),
    };
  }

  /**
   * Retire a showtime whose screening has started.
   *
   * Returns true if the target is finished with, so callers can skip it.
   */
  async #retireIfStarted(target) {
    if (target.retired) return true;
    if (!hasStarted(target)) return false;

    target.retired = true;
    const when = formatLocal(target.startTime);
    const name = target.movie ?? `Showtime ${target.showtimeId}`;
    this.#log('info', `${name} (${when}) has started - no longer checking it`);
    this.emit('expired', {
      target: this.describeTarget(target),
      at: new Date().toISOString(),
    });

    if (this.notify?.macos !== false) {
      await macNotify({
        title: 'Showtime has started',
        subtitle: name,
        message: `${when} - no longer being checked`,
        sound: this.notify?.sound ?? 'Glass',
      });
    }
    return true;
  }

  /**
   * Poll one showtime, joining any check already running for it.
   *
   * This per-target guard is what makes the global serialiser unnecessary: a
   * UI-triggered check and the background cycle can overlap safely across
   * different showtimes, and collapse into one request for the same showtime.
   */
  #checkTarget(target) {
    if (target.inFlight) return target.inFlight;
    const p = this.#runCheck(target).finally(() => {
      if (target.inFlight === p) target.inFlight = null;
    });
    target.inFlight = p;
    return p;
  }

  /** The actual check. Never throws: failures are recorded and backed off. */
  async #runCheck(target) {
    if (target.retired || target.paused) return;

    let result;
    try {
      const availability = await fetchAvailability(target.locationId, target.showtimeId);
      result = matchSeats(target.seatIndex, availability, this.effectiveWant(target));
      target.failures = 0;
      target.error = null;
    } catch (err) {
      target.failures++;
      const wait = BACKOFF_STEPS[Math.min(target.failures - 1, BACKOFF_STEPS.length - 1)];
      target.skipUntil = Date.now() + wait;
      target.error = err instanceof HttpError ? `HTTP ${err.status}` : err.message;
      this.#log('warn', `${target.showtimeId} check failed (${target.error}) - retrying in ${Math.round(wait / 1000)}s`);
      this.emit('target', this.describeTarget(target));
      return;
    }

    // The target may have been removed while this request was in flight.
    if (!this.#targets.has(target.key)) return;

    target.lastResult = result;
    target.lastChecked = new Date().toISOString();

    // A finished showtime will never free up; stop asking about it.
    if (result.isPostShowtime) {
      target.retired = true;
      this.#log('info', `Showtime ${target.showtimeId} has passed - no longer checking it`);
    }

    const change = this.#tracker.update(target.key, result.runs);
    this.emit('target', this.describeTarget(target));

    if (change === 'appeared') {
      this.#alerts++;
      const payload = { target: this.describeTarget(target), runs: result.runs, at: new Date().toISOString() };
      this.emit('alert', payload);
      await this.#fireNotification(target, result.runs);
    } else if (change === 'gone') {
      this.#log('info', `${target.showtimeId}: matching seats were taken again`);
      this.emit('gone', { key: target.key, at: new Date().toISOString() });
    }
  }

  async #fireNotification(target, runs) {
    if (this.notify?.macos === false) return;
    const best = runs[0];
    const extra = runs.length - 1;
    const more = extra > 0 ? ` (+${extra} more block${extra > 1 ? 's' : ''})` : '';
    await macNotify({
      title: 'Cineplex seats available',
      subtitle: target.movie ?? `Showtime ${target.showtimeId}`,
      message: `Row ${best.row}: ${best.seats.join(', ')}${more}`,
      sound: this.notify?.sound ?? 'Glass',
    });
  }

  /**
   * One pass over every eligible target, up to `maxConcurrency` at a time.
   *
   * Returns true when every target has retired (all showtimes have passed),
   * which tells the caller there is nothing left to watch.
   */
  async runCycle() {
    const startedAt = Date.now();
    const due = [];
    let anyLive = false;

    for (const target of this.#targets.values()) {
      if (target.retired) continue;
      // Checked every cycle so a showtime stops being polled the moment it
      // starts, rather than whenever Cineplex gets round to admitting it.
      if (await this.#retireIfStarted(target)) continue;
      if (target.paused) continue;
      anyLive = true;
      if (Date.now() < target.skipUntil) continue; // backing off after a failure
      due.push(target);
    }

    await pool(due, this.maxConcurrency, (target) => this.#checkTarget(target));

    this.#lastCycleMs = Date.now() - startedAt;
    this.emit('cycle', {
      at: new Date().toISOString(),
      anyLive,
      checked: due.length,
      durationMs: this.#lastCycleMs,
      concurrency: Math.min(this.maxConcurrency, due.length),
    });
    return !anyLive;
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    this.#startedAt = Date.now();
    this.#abort = new AbortController();
    void this.#loop(this.#abort.signal);
  }

  stop() {
    this.#running = false;
    this.#nextCycleAt = null;
    this.#abort?.abort();
  }

  async #loop(signal) {
    while (!signal.aborted) {
      await this.runCycle();
      if (signal.aborted) break;

      // Jitter keeps concurrent requests from landing as a synchronised burst.
      const jitter = Math.floor((Math.random() * 2 - 1) * JITTER_MS);
      const wait = Math.max(5_000, this.pollSeconds * 1000 + jitter);

      // Publish the actual due time — jitter means the UI cannot derive it
      // from pollSeconds alone, and a drifting countdown looks broken.
      this.#nextCycleAt = Date.now() + wait;
      this.emit('scheduled', { nextCycleAt: this.#nextCycleAt, waitMs: wait });

      await sleep(wait);
    }
    this.#nextCycleAt = null;
  }
}

/**
 * Has the screening already begun?
 *
 * Judged on the UTC instant Cineplex publishes, so it is correct regardless of
 * the machine's timezone. Cineplex's own `isPostShowtime` flag cannot be used
 * for this - it was still false for showtimes three minutes from starting.
 */
export function hasStarted(target, now = Date.now()) {
  if (!target.startTimeUtc) return false;
  const t = Date.parse(target.startTimeUtc);
  return Number.isFinite(t) && now >= t;
}

function clampConcurrency(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.floor(n));
}

/**
 * Render "2026-08-22T19:00:00" as "Aug 22, 7:00 PM".
 *
 * The components are formatted as written rather than parsed as an instant, so
 * the theatre's local time is shown verbatim whatever timezone we run in.
 */
export function formatLocal(iso) {
  if (!iso) return 'unknown time';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return iso;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  return d.toLocaleString('en-CA', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
  });
}

/** Fetch the static layout + movie metadata once. Only availability is re-polled. */
export async function warmup(target) {
  const [layout, meta] = await Promise.all([
    fetchSeatLayout(target.locationId, target.showtimeId),
    // Metadata is cosmetic; a failure here must not stop us watching the seats.
    fetchShowtimeMeta(target.locationId, target.showtimeId).catch(() => null),
  ]);
  target.seatIndex = buildSeatIndex(layout);
  target.movie = meta?.movie ?? null;
  target.theatre = meta?.theatre ?? null;
  target.showDate = meta?.showDate ?? null;
  // Local start time, e.g. "2026-08-22T15:00:00". showDate is date-only, so
  // this nested field is the only place the actual screening time appears.
  target.startTime = meta?.showtime?.showStartDateTime ?? null;
  // The UTC instant is what expiry is judged on. The local string above has no
  // zone, so comparing it would silently depend on this machine's timezone.
  target.startTimeUtc = meta?.showtime?.showStartDateTimeUtc ?? null;
  target.rows = [...new Set([...target.seatIndex.values()].map((s) => s.row))].sort();
  return target;
}

export { DEFAULT_CONCURRENCY, MAX_CONCURRENCY };
