#!/usr/bin/env node
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Watcher } from './src/watcher.js';
import { ConfigStore } from './src/store.js';
import { createControlServer } from './src/server.js';
import { color, macNotify, printMatch, printStatus } from './src/notify.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const HELP = `
Cineplex seat watcher - alerts when adjacent seats you want become available.

  node index.js                 watch in the terminal
  node index.js --serve         open the web control panel (add showtimes in a browser)
  node index.js --once          run a single check and exit
  node index.js --test-alert    fire a sample notification and exit

  --port N                      port for --serve (default 8787)
  --config PATH                 use a different config file (default config.json)
`;

function parseArgs(argv) {
  const flags = { serve: false, once: false, testAlert: false, config: 'config.json', port: 8787 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--serve') flags.serve = true;
    else if (a === '--once') flags.once = true;
    else if (a === '--test-alert') flags.testAlert = true;
    else if (a === '--config') flags.config = argv[++i];
    else if (a === '--port') flags.port = Number(argv[++i]);
    else if (a === '--help' || a === '-h') flags.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      flags.help = true;
    }
  }
  return flags;
}

function describeWant(want) {
  const rows = want?.rows?.length ? `rows ${want.rows.join(', ')}` : 'any row';
  const n = want?.adjacentSeats ?? 1;
  const together = n > 1 ? `${n} seats together` : 'any single seat';
  const special = want?.allowSpecialSeats ? ', accessible seating included' : '';
  return `${together} in ${rows}${special}`;
}

/** Mirror watcher events to the terminal. */
function attachConsole(watcher, { verbose = true } = {}) {
  watcher.on('target', (t) => {
    if (t.result) printStatus(t, t.result);
  });
  watcher.on('alert', ({ target, runs }) => printMatch(target, runs));
  watcher.on('log', ({ level, message }) => {
    if (!verbose && level === 'info') return;
    const paint = level === 'warn' ? color.yellow : level === 'error' ? color.red : color.dim;
    console.log(paint(`  ${message}`));
  });
}

/** Load config and populate the watcher, reporting any showtime that fails. */
async function buildWatcher(store) {
  const cfg = await store.load();
  const watcher = new Watcher({
    pollSeconds: cfg.pollSeconds,
    want: cfg.want,
    notify: cfg.notify,
    maxConcurrency: cfg.maxConcurrency,
  });

  // Loaded in parallel: startup costs about one round trip, not one per
  // showtime. No immediate check — the caller runs a cycle next, and checking
  // here would make that cycle look like an unchanged repeat.
  const { failed } = await watcher.addTargets(
    cfg.targets.map((t) => ({ url: t.url, want: t.want, check: false }))
  );
  for (const f of failed) {
    console.error(color.red(`  ! could not load showtime ${f.showtimeId}: ${f.error}`));
  }
  restorePaused(watcher, cfg);
  return { watcher, cfg };
}

/** Re-apply saved pause flags after a bulk restore. */
function restorePaused(watcher, cfg) {
  for (const t of cfg.targets) {
    if (!t.paused) continue;
    try {
      watcher.setPaused(`${t.locationId}/${t.showtimeId}`, true);
    } catch {
      // That showtime failed to load; its error was already reported.
    }
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(HELP);
    return;
  }

  if (flags.testAlert) {
    console.log('Sending a test notification...');
    const ok = await macNotify({
      title: 'Cineplex seats available',
      subtitle: 'Test alert - no real seats',
      message: 'Row F: F12, F13',
      sound: 'Glass',
    });
    console.log(
      ok
        ? color.green(
            'Notification sent. If no banner appeared, enable notifications for your ' +
              'terminal app in System Settings > Notifications.'
          )
        : color.yellow('Notification could not be sent - terminal output is still your alert.')
    );
    return;
  }

  const store = new ConfigStore(resolve(HERE, flags.config));

  // ── Web control panel ───────────────────────────────────────────
  if (flags.serve) {
    const cfg = await store.load();
    const watcher = new Watcher({
      pollSeconds: cfg.pollSeconds,
      want: cfg.want,
      notify: cfg.notify,
      maxConcurrency: cfg.maxConcurrency,
    });
    attachConsole(watcher, { verbose: false });

    const persist = () => store.save(watcher.toConfig());
    const server = createControlServer({ watcher, onChange: persist });

    const url = `http://127.0.0.1:${flags.port}`;
    server.listen(flags.port, '127.0.0.1', async () => {
      console.log(color.bold('\nCineplex seat watcher'));
      console.log(`  control panel: ${color.cyan(url)}`);
      console.log(color.dim('  Add showtimes in the browser. Ctrl+C to stop.\n'));

      // Restore the saved watch list once the UI can already connect, so a slow
      // showtime lookup never delays the page being reachable. Loaded in
      // parallel, and with no immediate check because start() runs a full
      // cycle straight after.
      const { failed } = await watcher.addTargets(
        cfg.targets.map((t) => ({ url: t.url, want: t.want, check: false }))
      );
      for (const f of failed) {
        console.error(color.red(`  ! could not restore showtime ${f.showtimeId}: ${f.error}`));
      }
      restorePaused(watcher, cfg);
      watcher.start();
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(color.red(`\nPort ${flags.port} is already in use. Try --port ${flags.port + 1}.`));
        process.exit(1);
      }
      throw err;
    });

    process.on('SIGINT', () => {
      watcher.stop();
      console.log(color.dim(`\n\nStopped - ${watcher.alerts} alert(s) fired.`));
      process.exit(0);
    });
    return;
  }

  // ── Terminal modes ──────────────────────────────────────────────
  const { watcher, cfg } = await buildWatcher(store);

  console.log(color.bold('\nCineplex seat watcher'));
  console.log(`  looking for: ${color.cyan(describeWant(cfg.want))}`);
  console.log(
    `  polling every ${watcher.pollSeconds}s across ${watcher.getState().targets.length} showtime(s)\n`
  );

  for (const t of watcher.getState().targets) {
    const date = t.showDate ? ` on ${t.showDate.slice(0, 10)}` : '';
    console.log(
      `  ${color.bold(String(t.showtimeId))}  ${t.movie ?? 'unknown film'}` +
        color.dim(`${date} - ${t.theatre ?? 'unknown theatre'} - ${t.seatCount} seats`)
    );
  }
  console.log('');

  if (!watcher.getState().targets.length) {
    throw new Error('None of the configured showtimes could be loaded.');
  }

  attachConsole(watcher);

  if (flags.once) {
    await watcher.runCycle();
    return;
  }

  process.on('SIGINT', () => {
    const mins = Math.round((Date.now() - watcher.startedAt) / 60_000);
    console.log(color.dim(`\n\nStopped after ${mins} minute(s) - ${watcher.alerts} alert(s) fired.`));
    process.exit(0);
  });

  console.log(color.dim('Watching. Press Ctrl+C to stop.\n'));
  watcher.start();
}

main().catch((err) => {
  console.error(color.red(`\nError: ${err.message}`));
  process.exit(1);
});
