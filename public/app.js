// Control panel for the seat watcher. Talks to the local Node process over a
// small JSON API, and receives live updates over Server-Sent Events.

const $ = (sel) => document.querySelector(sel);

/**
 * Must match API_VERSION in src/server.js.
 *
 * Static files are read from disk per request, but src/ is loaded into the Node
 * process at startup — so a server left running across an edit serves this new
 * page from an old API. That mismatch used to surface as a confusing validation
 * error; now it says plainly that the server needs restarting.
 */
const EXPECTED_API_VERSION = 5;

const el = {
  brandSub: $('#brandSub'),
  livePill: $('#livePill'),
  liveText: $('#liveText'),
  checkNow: $('#checkNow'),
  countdown: $('#countdown'),
  countdownText: $('#countdownText'),
  ringFill: $('#ringFill'),
  scanFill: $('#scanFill'),
  tabBadge: $('#tabBadge'),
  statWatching: $('#statWatching'),
  statFree: $('#statFree'),
  statHits: $('#statHits'),
  statHitTile: $('#statHitTile'),
  statChecked: $('#statChecked'),
  statDuration: $('#statDuration'),
  maxConcurrency: $('#maxConcurrency'),
  addForm: $('#addForm'),
  addBtn: $('#addBtn'),
  addError: $('#addError'),
  addCount: $('#addCount'),
  locationId: $('#locationId'),
  showtimeId: $('#showtimeId'),
  pasteUrl: $('#pasteUrl'),
  pasteHint: $('#pasteHint'),
  adjacentSeats: $('#adjacentSeats'),
  rowsInput: $('#rowsInput'),
  rowChips: $('#rowChips'),
  pollSeconds: $('#pollSeconds'),
  allowSpecialSeats: $('#allowSpecialSeats'),
  saveRules: $('#saveRules'),
  rulesSaved: $('#rulesSaved'),
  targets: $('#targets'),
  emptyState: $('#emptyState'),
  ruleBar: $('#ruleBar'),
  ruleText: $('#ruleText'),
  ruleEdit: $('#ruleEdit'),
  goToSettings: $('#goToSettings'),
  logWrap: $('#logWrap'),
  log: $('#log'),
  logCount: $('#logCount'),
  clearLog: $('#clearLog'),
  toasts: $('#toasts'),
  tpl: $('#targetTpl'),
  groupTpl: $('#groupTpl'),
  knownTpl: $('#knownTpl'),
  knownCard: $('#knownCard'),
  knownList: $('#knownList'),
};

/** Last state pushed by the server. */
let state = { targets: [], settings: null, alerts: 0 };
/** Rows the user has selected, kept in sync with the text field and the chips. */
let selectedRows = [];
/** True while the user is mid-edit, so live pushes don't yank the inputs. */
let editingRules = false;
let logLines = 0;
/** When the server says the next poll is due, and how long that wait is. */
let nextCycleAt = null;
let cycleWaitMs = null;
/** Timing of the most recent poll, shown under "Last check". */
let lastCycle = null;

// ── helpers ────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const clockOf = (iso) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';

function splitIds(text) {
  return String(text || '').split(/[\s,;]+/).filter(Boolean);
}

function parseRows(text) {
  return [...new Set(String(text || '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean))];
}

function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ico');
  svg.setAttribute('viewBox', '0 0 24 24');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

// ── tabs ───────────────────────────────────────────────────────────

function showTab(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    const on = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(on));
    document.querySelector(`#panel${tab.dataset.tab === 'watching' ? 'Watching' : 'Settings'}`).hidden = !on;
  }
  try {
    localStorage.setItem('seatwatcher.tab', name);
  } catch {
    /* private windows and blocked storage are fine — the tab just won't persist */
  }
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => showTab(tab.dataset.tab));
}
el.goToSettings.addEventListener('click', () => showTab('settings'));
el.ruleEdit.addEventListener('click', () => showTab('settings'));

try {
  showTab(localStorage.getItem('seatwatcher.tab') === 'settings' ? 'settings' : 'watching');
} catch {
  showTab('watching');
}

// ── toasts & log ───────────────────────────────────────────────────

function toast(kind, title, detail) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.dataset.kind = kind;
  node.append(icon(kind === 'error' ? 'i-alert' : 'i-check'));

  const body = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = title;
  body.append(strong);
  if (detail) {
    const span = document.createElement('span');
    span.textContent = detail;
    body.append(span);
  }
  node.append(body);
  el.toasts.append(node);
  setTimeout(() => node.remove(), kind === 'error' ? 6000 : 9000);
}

function addLog(level, message, at) {
  const li = document.createElement('li');
  const time = document.createElement('time');
  time.textContent = clockOf(at || new Date().toISOString());
  const span = document.createElement('span');
  span.className = `lv-${level}`;
  span.textContent = message;
  li.append(time, span);
  el.log.prepend(li);
  while (el.log.children.length > 80) el.log.lastElementChild.remove();
  logLines = el.log.children.length;
  el.logCount.textContent = logLines ? `${logLines}` : '';
}

// ── rendering ──────────────────────────────────────────────────────

/**
 * When the film actually starts.
 *
 * `startTime` has no timezone suffix, so JS parses it as local — which is what
 * we want, since it is already the theatre's local time. Falls back to the
 * date alone if Cineplex ever omits it.
 */
function formatWhen(t) {
  if (t.startTime) {
    const d = new Date(t.startTime);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString([], {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
      });
    }
  }
  return t.showDate ? t.showDate.slice(0, 10) : `#${t.showtimeId}`;
}

function describeRule(want) {
  const n = want?.adjacentSeats ?? 1;
  const seats = n > 1 ? `${n} together` : 'any single seat';
  const rows = want?.rows?.length ? `rows ${want.rows.join(', ')}` : 'any row';
  return `${seats} in ${rows}`;
}

/** Numeric-aware compare, so "1409" sorts after "537" rather than before it. */
function byId(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}

function render() {
  const targets = state.targets ?? [];
  el.emptyState.hidden = targets.length > 0;

  // Sort before grouping. Showtimes are loaded in parallel, so arrival order is
  // whatever the network decided — without this the cards would shuffle on
  // every restart. Location, then showtime, both numerically.
  const ordered = [...targets].sort(
    (a, b) => byId(a.locationId, b.locationId) || byId(a.showtimeId, b.showtimeId)
  );

  const byLocation = new Map();
  for (const t of ordered) {
    if (!byLocation.has(t.locationId)) byLocation.set(t.locationId, []);
    byLocation.get(t.locationId).push(t);
  }

  // Rebuild in place, keyed by location and showtime, so unrelated cards
  // don't flash on every poll.
  const seenGroups = new Set();
  for (const [locationId, list] of byLocation) {
    seenGroups.add(locationId);

    let group = el.targets.querySelector(`.loc-group[data-location="${CSS.escape(locationId)}"]`);
    if (!group) {
      group = el.groupTpl.content.firstElementChild.cloneNode(true);
      group.dataset.location = locationId;
      el.targets.append(group);
    }

    const hits = list.filter((t) => (t.result?.runs?.length ?? 0) > 0 && !t.paused).length;
    group.dataset.matched = String(hits > 0);
    group.querySelector('.loc-name').textContent =
      list.find((t) => t.theatre)?.theatre || `Location ${locationId}`;

    const meta = group.querySelector('.loc-meta');
    meta.replaceChildren(
      document.createTextNode(`#${locationId} · ${list.length} showtime${list.length === 1 ? '' : 's'}`)
    );
    if (hits) {
      const b = document.createElement('b');
      b.textContent = ` · ${hits} with seats`;
      meta.append(b);
    }

    const holder = group.querySelector('.loc-cards');
    const seenCards = new Set();
    for (const t of list) {
      seenCards.add(t.key);
      let card = holder.querySelector(`[data-key="${CSS.escape(t.key)}"]`);
      if (!card) {
        card = el.tpl.content.firstElementChild.cloneNode(true);
        card.dataset.key = t.key;
        wireCard(card, t.key);
        holder.append(card);
      }
      paintCard(card, t);
    }
    for (const card of [...holder.children]) {
      if (!seenCards.has(card.dataset.key)) card.remove();
    }
  }
  for (const group of [...el.targets.children]) {
    if (!seenGroups.has(group.dataset.location)) group.remove();
  }

  paintStats(targets);
  paintRuleBar(targets.length);
  paintKnownTheatres(byLocation);
  if (state.settings && !editingRules) paintRules(state.settings);
  paintRowChips();
}

/**
 * Settings list of theatres already being watched, each with an inline field
 * for adding more showtimes there.
 *
 * Rows are created once per location and then only their text is refreshed —
 * rebuilding them on every poll would wipe whatever is half-typed in the input.
 */
function paintKnownTheatres(byLocation) {
  el.knownCard.hidden = byLocation.size === 0;

  const seen = new Set();
  for (const [locationId, list] of byLocation) {
    seen.add(locationId);
    let row = el.knownList.querySelector(`.known[data-location="${CSS.escape(locationId)}"]`);
    if (!row) {
      row = el.knownTpl.content.firstElementChild.cloneNode(true);
      row.dataset.location = locationId;
      wireKnownRow(row, locationId);
      el.knownList.append(row);
    }

    row.querySelector('.known-name').textContent =
      list.find((t) => t.theatre)?.theatre || `Location ${locationId}`;
    row.querySelector('.known-id').textContent = `#${locationId}`;

    const chips = row.querySelector('.known-chips');
    chips.replaceChildren();
    for (const t of list) {
      const chip = document.createElement('span');
      chip.className = 'known-chip';
      chip.textContent = t.showtimeId;
      chip.dataset.matched = String((t.result?.runs?.length ?? 0) > 0 && !t.paused);
      chip.dataset.paused = String(t.paused);
      chip.title = [t.movie, t.paused ? 'paused' : null].filter(Boolean).join(' - ');
      chips.append(chip);
    }
  }

  for (const row of [...el.knownList.children]) {
    if (!seen.has(row.dataset.location)) row.remove();
  }
}

function wireKnownRow(row, locationId) {
  const form = row.querySelector('.known-add');
  const input = row.querySelector('.known-input');
  const button = row.querySelector('.known-btn');
  const errorEl = row.querySelector('.known-error');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ids = splitIds(input.value);
    if (!ids.length) {
      errorEl.textContent = 'Enter at least one showtime ID.';
      errorEl.hidden = false;
      return;
    }
    const clean = await submitShowtimes({ locationId, ids, button, errorEl,
      onAdded: () => { input.value = ''; } });
    if (clean) showTab('watching');
  });
}

function paintRuleBar(count) {
  const want = state.settings?.want;
  el.ruleBar.hidden = !want || count === 0;
  if (el.ruleBar.hidden) return;
  el.ruleText.textContent = describeRule(want);
}

function paintStats(targets) {
  const live = targets.filter((t) => !t.paused && !t.retired);
  const free = targets.reduce((n, t) => n + (t.result?.freeCount ?? 0), 0);
  const hits = targets.filter((t) => (t.result?.runs?.length ?? 0) > 0 && !t.paused).length;
  const last = targets.map((t) => t.lastChecked).filter(Boolean).sort().pop();

  el.statWatching.textContent = live.length;
  el.statFree.textContent = free;
  el.statHits.textContent = hits;
  el.statHitTile.dataset.hit = String(hits > 0);
  el.statChecked.textContent = last ? clockOf(last) : '—';

  // Show how long the last pass took — with parallel checks this stays flat as
  // more showtimes are added, which is the whole point of the worker pool.
  const ms = lastCycle?.durationMs ?? state.lastCycleMs;
  if (ms == null) el.statDuration.textContent = '';
  else {
    const took = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
    const n = lastCycle?.checked;
    el.statDuration.textContent = n ? `${took} · ${n} in parallel` : took;
  }

  el.tabBadge.hidden = hits === 0;
  el.tabBadge.textContent = hits;
}

function wireCard(card, key) {
  const [locationId, showtimeId] = key.split('/');
  const base = `/api/targets/${encodeURIComponent(locationId)}/${encodeURIComponent(showtimeId)}`;

  card.querySelector('.js-pause').addEventListener('click', async () => {
    const paused = card.dataset.paused === 'true';
    try {
      await api(base, { method: 'PATCH', body: JSON.stringify({ paused: !paused }) });
    } catch (err) {
      toast('error', 'Could not update', err.message);
    }
  });

  card.querySelector('.js-remove').addEventListener('click', async () => {
    const name = card.querySelector('.target-movie').textContent;
    if (!confirm(`Stop watching ${name}?`)) return;
    try {
      await api(base, { method: 'DELETE' });
    } catch (err) {
      toast('error', 'Could not remove', err.message);
    }
  });
}

function paintCard(card, t) {
  const result = t.result;
  const runs = result?.runs ?? [];
  const matched = runs.length > 0 && !t.paused;
  const wasMatched = card.dataset.matched === 'true';

  card.dataset.paused = String(t.paused);
  card.dataset.matched = String(matched);

  // Pulse only on the transition into a match, not on every refresh of one.
  if (matched && !wasMatched) {
    card.classList.remove('just-matched');
    void card.offsetWidth; // reflow, so the animation restarts
    card.classList.add('just-matched');
  } else if (!matched) {
    card.classList.remove('just-matched');
  }

  card.querySelector('.target-movie').textContent = t.movie || `Showtime ${t.showtimeId}`;

  // Start time leads, then date and free count. Theatre lives on the group
  // header and the matching rule is stated once above the list, so neither is
  // repeated here.
  card.querySelector('.js-when').textContent = formatWhen(t);
  const free = result ? `${result.freeCount} free` : null;
  card.querySelector('.js-rest').textContent =
    [`#${t.showtimeId}`, free].filter(Boolean).join(' · ');

  card.querySelector('.js-open').href = t.url;

  const pause = card.querySelector('.js-pause');
  pause.replaceChildren(icon(t.paused ? 'i-play' : 'i-pause'));
  pause.title = t.paused ? 'Resume' : 'Pause';

  // Match banner
  const matchBox = card.querySelector('.js-match');
  matchBox.hidden = !matched;
  if (matched) {
    const total = runs.reduce((n, r) => n + r.seats.length, 0);
    card.querySelector('.js-match-title').textContent =
      `${total} seat${total === 1 ? '' : 's'} available in ${runs.length} block${runs.length === 1 ? '' : 's'}`;
    card.querySelector('.js-book').href = t.url;

    const list = card.querySelector('.js-runs');
    list.replaceChildren();
    for (const run of runs.slice(0, 6)) {
      const li = document.createElement('li');
      const row = document.createElement('span');
      row.className = 'run-row';
      row.textContent = `Row ${run.row}`;
      const seats = document.createElement('span');
      seats.className = 'run-seats';
      seats.textContent = run.seats.join(', ');
      li.append(row, seats);
      if (run.types?.some((x) => x !== 'Standard')) {
        const note = document.createElement('span');
        note.className = 'run-note';
        note.textContent = '(accessible)';
        li.append(note);
      }
      list.append(li);
    }
    if (runs.length > 6) {
      const li = document.createElement('li');
      li.className = 'run-note';
      li.textContent = `+${runs.length - 6} more`;
      list.append(li);
    }
  }

  const status = card.querySelector('.js-status');
  status.className = 'stat js-status';
  if (t.error) {
    status.textContent = t.error;
    status.classList.add('stat-bad');
  } else if (t.retired) {
    status.textContent = 'showtime has passed';
  } else if (t.paused) {
    status.textContent = 'paused';
  } else if (result?.isSoldOut) {
    status.textContent = 'sold out';
    status.classList.add('stat-warn');
  } else if (t.want && Object.keys(t.want).length) {
    // Only worth saying when this showtime departs from the global rule —
    // otherwise it is the same sentence repeated on every card.
    status.textContent = `own rule: ${describeRule(t.effectiveWant)}`;
  } else {
    status.textContent = '';
  }

  // Per-row free-seat breakdown.
  //
  // The count is prefixed with a multiplication sign ("I ×1") because a bare
  // "I 1" reads as the seat label I1 — these are counts of free seats in a row,
  // not seat numbers. The exact labels are in the tooltip.
  const bar = card.querySelector('.js-rowbar');
  bar.replaceChildren();
  const wanted = new Set((t.effectiveWant?.rows ?? []).map((r) => String(r).toUpperCase()));
  const allowSpecial = Boolean(t.effectiveWant?.allowSpecialSeats);
  for (const row of result?.freeByRow ?? []) {
    const tag = document.createElement('span');
    tag.className = 'rowtag';
    if (wanted.has(String(row.row).toUpperCase())) tag.dataset.wanted = 'true';

    const letter = document.createElement('b');
    letter.textContent = row.row;
    tag.append(letter);

    // Wheelchair spaces and their companion seats are separate seats in the
    // data (and on Cineplex's own map), so a row like E reads as inflated when
    // they are lumped in with normal seats. Split them out.
    const standard = row.labels.length - row.special;
    if (standard > 0 || row.special === 0) {
      const count = document.createElement('i');
      count.textContent = ` ×${standard}`;
      tag.append(count);
    }
    if (row.special > 0) {
      const acc = document.createElement('span');
      acc.className = 'rowtag-acc';
      acc.dataset.inactive = String(!allowSpecial);
      acc.append(icon('i-access'));
      const n = document.createElement('i');
      n.textContent = row.special;
      acc.append(n);
      tag.append(acc);
    }

    const parts = [`Row ${row.row}: ${row.labels.join(', ')}`];
    if (row.special > 0) {
      parts.push(
        `${row.special} of these are wheelchair/companion seats` +
        (allowSpecial ? '' : ' and are excluded by your rule')
      );
    }
    tag.title = parts.join('\n');
    bar.append(tag);
  }
}

function paintRules(settings) {
  el.adjacentSeats.value = settings.want?.adjacentSeats ?? 2;
  el.pollSeconds.value = settings.pollSeconds ?? 30;
  el.maxConcurrency.value = settings.maxConcurrency ?? 6;
  el.allowSpecialSeats.checked = Boolean(settings.want?.allowSpecialSeats);
  selectedRows = [...(settings.want?.rows ?? [])].map((r) => String(r).toUpperCase());
  el.rowsInput.value = selectedRows.join(', ');
}

/** Chips for every row that exists in any watched auditorium. */
function paintRowChips() {
  const all = [...new Set((state.targets ?? []).flatMap((t) => t.rows ?? []))].sort();
  el.rowChips.replaceChildren();
  if (!all.length) return;

  for (const row of all) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = row;
    chip.setAttribute('aria-pressed', String(selectedRows.includes(row)));
    chip.addEventListener('click', () => {
      selectedRows = selectedRows.includes(row)
        ? selectedRows.filter((r) => r !== row)
        : [...selectedRows, row].sort();
      el.rowsInput.value = selectedRows.join(', ');
      editingRules = true;
      paintRowChips();
    });
    el.rowChips.append(chip);
  }
}

// ── countdown to the next check ────────────────────────────────────

const RING_CIRCUMFERENCE = 100.53; // 2 * pi * r, with r = 16

function paintCountdown() {
  // Nothing scheduled yet. That is either a check already in flight (common on
  // first connect, while the opening cycle runs) or an idle watcher.
  if (!nextCycleAt || !cycleWaitMs) {
    const checking = state.running && (state.targets ?? []).some((t) => !t.paused && !t.retired);
    el.countdownText.textContent = checking ? '···' : '—';
    el.countdown.title = checking ? 'Checking now' : 'Not scheduled';
    el.ringFill.style.strokeDashoffset = checking ? 0 : RING_CIRCUMFERENCE;
    el.scanFill.style.width = '0%';
    el.countdown.dataset.soon = String(Boolean(checking));
    return;
  }

  const remaining = Math.max(0, nextCycleAt - Date.now());
  const secs = Math.ceil(remaining / 1000);
  const fraction = Math.min(1, Math.max(0, remaining / cycleWaitMs));

  el.countdownText.textContent = remaining <= 250 ? '···' : `${secs}`;
  el.countdown.title = `Next check in ${secs}s`;
  el.countdown.dataset.soon = String(secs <= 5);

  // Ring drains as the wait elapses; the bar fills as it completes.
  el.ringFill.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - fraction);
  el.scanFill.style.width = `${(1 - fraction) * 100}%`;
}

setInterval(paintCountdown, 250);

// ── events from the server ─────────────────────────────────────────

function connect() {
  const source = new EventSource('/api/events');

  source.addEventListener('open', () => setLive('live', 'live'));
  source.addEventListener('error', () => setLive('down', 'reconnecting'));

  source.addEventListener('state', (e) => {
    state = JSON.parse(e.data);
    checkServerVersion();
    if (state.nextCycleAt) {
      nextCycleAt = state.nextCycleAt;
      cycleWaitMs = cycleWaitMs ?? (state.pollSeconds ?? 30) * 1000;
    }
    render();
    updateBrand();
    paintCountdown();
  });

  source.addEventListener('scheduled', (e) => {
    const { nextCycleAt: at, waitMs } = JSON.parse(e.data);
    nextCycleAt = at;
    cycleWaitMs = waitMs;
    paintCountdown();
  });

  source.addEventListener('target', (e) => {
    const updated = JSON.parse(e.data);
    const i = state.targets.findIndex((t) => t.key === updated.key);
    if (i >= 0) state.targets[i] = updated;
    else state.targets.push(updated);
    render();
  });

  source.addEventListener('alert', (e) => {
    const { target, runs } = JSON.parse(e.data);
    const best = runs[0];
    const name = target.movie || `Showtime ${target.showtimeId}`;
    const seats = `Row ${best.row}: ${best.seats.join(', ')}`;
    toast('hit', `Seats available - ${name}`, seats);
    addLog('hit', `${name} - ${seats}`);
    browserNotify(name, seats, target.url);
  });

  source.addEventListener('gone', (e) => {
    const { key } = JSON.parse(e.data);
    addLog('info', `${key}: matching seats were taken again`);
  });

  source.addEventListener('cycle', (e) => {
    lastCycle = JSON.parse(e.data);
    updateBrand();
    paintStats(state.targets ?? []);
  });

  source.addEventListener('log', (e) => {
    const { level, message, at } = JSON.parse(e.data);
    addLog(level, message, at);
  });
}

function setLive(stateName, text) {
  el.livePill.dataset.state = stateName;
  el.liveText.textContent = text;
}

/** Warn once if the running server predates this page. */
let versionWarned = false;
function checkServerVersion() {
  if (versionWarned) return;
  if (state.apiVersion === EXPECTED_API_VERSION) return;
  versionWarned = true;

  const banner = document.createElement('div');
  banner.className = 'stale-banner';
  banner.append(icon('i-alert'));
  const text = document.createElement('span');
  text.textContent =
    'This page is newer than the server running it. Stop the server (Ctrl+C) and ' +
    'run "node index.js --serve" again, then reload.';
  banner.append(text);
  document.querySelector('.wrap').prepend(banner);
  setLive('down', 'restart needed');
}

function updateBrand() {
  const active = (state.targets ?? []).filter((t) => !t.paused && !t.retired).length;
  const every = state.settings?.pollSeconds ?? 30;
  el.brandSub.textContent = active
    ? `Checking ${active} showtime${active === 1 ? '' : 's'} every ${every}s`
    : 'Nothing being watched';
}

/**
 * Browser notification, in addition to the macOS one the server fires.
 * Useful when the browser is focused on another tab.
 */
function browserNotify(title, body, url) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag: url });
    n.onclick = () => {
      window.open(url, '_blank', 'noopener');
      n.close();
    };
  } catch {
    /* notifications are a bonus, never a hard requirement */
  }
}

// ── wiring ─────────────────────────────────────────────────────────

/**
 * Submit showtimes for one location.
 *
 * Shared by the generic form and by each known-theatre row, so both go through
 * the same validated endpoint and report partial failures the same way.
 * Returns true when every requested showtime was added.
 */
async function submitShowtimes({ locationId, ids, button, errorEl, onAdded }) {
  errorEl.hidden = true;
  button.disabled = true;
  try {
    const { added, failed } = await api('/api/targets', {
      method: 'POST',
      body: JSON.stringify({ locationId, showtimeIds: ids }),
    });

    if (added.length) {
      toast(
        'hit',
        `Now watching ${added.length} showtime${added.length === 1 ? '' : 's'}`,
        added.map((a) => `#${a.showtimeId}`).join(', ')
      );
      onAdded?.();
    }

    // A partial success still needs the failures spelled out, one per line.
    if (failed.length) {
      errorEl.textContent = failed.map((f) => `${f.showtimeId}: ${f.error}`).join('\n');
      errorEl.hidden = false;
    }
    return added.length > 0 && failed.length === 0;
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
    return false;
  } finally {
    button.disabled = false;
  }
}

el.addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const clean = await submitShowtimes({
    locationId: el.locationId.value.trim(),
    ids: splitIds(el.showtimeId.value),
    button: el.addBtn,
    errorEl: el.addError,
    onAdded: () => {
      el.showtimeId.value = '';
      el.pasteUrl.value = '';
      updateAddCount();
    },
  });
  if (clean) showTab('watching');
});

/** Live count under the ID field, so a long paste is easy to sanity-check. */
function updateAddCount() {
  const n = splitIds(el.showtimeId.value).length;
  el.addCount.textContent = n > 1
    ? `${n} showtimes will be added.`
    : 'Separate several showtimes with commas or spaces.';
}
el.showtimeId.addEventListener('input', updateAddCount);

// Pasted links fill in the fields above. Several at once is fine.
el.pasteUrl.addEventListener('input', () => {
  const raw = el.pasteUrl.value.trim();
  if (!raw) {
    el.pasteHint.textContent = 'One link per line, or several separated by spaces.';
    return;
  }

  const locations = new Set();
  const showtimes = [];
  let bad = 0;

  for (const chunk of raw.split(/\s+/).filter(Boolean)) {
    try {
      const params = new URL(chunk).searchParams;
      const loc = params.get('locationId');
      const show = params.get('showtimeId');
      if (!loc || !show) { bad++; continue; }
      locations.add(loc);
      if (!showtimes.includes(show)) showtimes.push(show);
    } catch {
      bad++;
    }
  }

  if (!showtimes.length) {
    el.pasteHint.textContent = bad ? 'No ticketing links found in that text.' : 'That does not look like a URL yet.';
    return;
  }

  // The form watches one theatre at a time, so mixed locations need a decision.
  if (locations.size > 1) {
    el.pasteHint.textContent =
      `Those links cover ${locations.size} different theatres (${[...locations].join(', ')}). ` +
      'Paste one theatre at a time.';
    return;
  }

  const [loc] = [...locations];
  el.locationId.value = loc;
  el.showtimeId.value = showtimes.join(', ');
  updateAddCount();
  el.pasteHint.textContent =
    `Found ${showtimes.length} showtime${showtimes.length === 1 ? '' : 's'} at location ${loc}` +
    (bad ? ` (${bad} line${bad === 1 ? '' : 's'} skipped)` : '') + '. Press Add.';
});

for (const input of [el.adjacentSeats, el.rowsInput, el.pollSeconds, el.allowSpecialSeats, el.maxConcurrency]) {
  input.addEventListener('input', () => {
    editingRules = true;
    if (input === el.rowsInput) {
      selectedRows = parseRows(el.rowsInput.value);
      paintRowChips();
    }
  });
}

el.saveRules.addEventListener('click', async () => {
  try {
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        pollSeconds: Number(el.pollSeconds.value) || 30,
        maxConcurrency: Number(el.maxConcurrency.value) || 6,
        want: {
          adjacentSeats: Math.max(1, Number(el.adjacentSeats.value) || 1),
          rows: parseRows(el.rowsInput.value),
          allowSpecialSeats: el.allowSpecialSeats.checked,
        },
      }),
    });
    editingRules = false;
    el.rulesSaved.hidden = false;
    setTimeout(() => (el.rulesSaved.hidden = true), 1800);
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  } catch (err) {
    toast('error', 'Could not save rules', err.message);
  }
});

el.checkNow.addEventListener('click', async () => {
  el.checkNow.disabled = true;
  try {
    await api('/api/check', { method: 'POST' });
  } catch (err) {
    toast('error', 'Check failed', err.message);
  } finally {
    el.checkNow.disabled = false;
  }
});

el.clearLog.addEventListener('click', () => {
  el.log.replaceChildren();
  logLines = 0;
  el.logCount.textContent = '';
});

connect();
