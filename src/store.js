import { readFile, writeFile, rename } from 'node:fs/promises';
import { parseTicketUrl } from './api.js';

const DEFAULTS = {
  pollSeconds: 30,
  maxConcurrency: 6,
  want: { adjacentSeats: 2, rows: [], allowSpecialSeats: false },
  notify: { macos: true, sound: 'Glass' },
  targets: [],
};

/**
 * Reads and writes config.json.
 *
 * Targets are accepted either as plain URL strings (the hand-written form) or as
 * objects, and are always written back as objects so UI-managed fields like
 * `paused` survive a restart.
 */
export class ConfigStore {
  constructor(path) {
    this.path = path;
  }

  async load() {
    let raw;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      return structuredClone(DEFAULTS);
    }

    let cfg;
    try {
      cfg = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Config file is not valid JSON (${this.path}): ${err.message}`);
    }

    return {
      pollSeconds: cfg.pollSeconds ?? DEFAULTS.pollSeconds,
      maxConcurrency: cfg.maxConcurrency ?? DEFAULTS.maxConcurrency,
      want: { ...DEFAULTS.want, ...(cfg.want ?? {}) },
      notify: { ...DEFAULTS.notify, ...(cfg.notify ?? {}) },
      targets: (Array.isArray(cfg.targets) ? cfg.targets : []).map(normaliseTarget),
    };
  }

  /** Atomic write, so a crash mid-save cannot truncate the config. */
  async save(state) {
    const body = {
      pollSeconds: state.pollSeconds,
      maxConcurrency: state.maxConcurrency,
      want: state.want,
      notify: state.notify,
      targets: state.targets.map((t) => {
        const entry = { url: t.url };
        if (t.want && Object.keys(t.want).length) entry.want = t.want;
        if (t.paused) entry.paused = true;
        return entry;
      }),
    };
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8');
    await rename(tmp, this.path);
  }
}

function normaliseTarget(entry) {
  const url = typeof entry === 'string' ? entry : entry?.url;
  const { locationId, showtimeId } = parseTicketUrl(url);
  return {
    url,
    locationId,
    showtimeId,
    want: (typeof entry === 'object' && entry?.want) || null,
    paused: Boolean(typeof entry === 'object' && entry?.paused),
  };
}

export { DEFAULTS };
