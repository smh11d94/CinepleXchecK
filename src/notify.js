import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const isTTY = process.stdout.isTTY;
const c = (code) => (s) => (isTTY ? `${ESC}[${code}m${s}${ESC}[0m` : String(s));

export const color = {
  bold: c('1'),
  dim: c('2'),
  red: c('31'),
  green: c('32'),
  yellow: c('33'),
  cyan: c('36'),
  invert: c('7'),
};

/**
 * AppleScript that reads its arguments from `on run argv`.
 *
 * Values are passed as real process arguments rather than interpolated into the
 * script text - movie titles contain characters like the registered-trademark
 * sign and colons that would otherwise break the AppleScript string literal.
 */
const NOTIFY_SCRIPT = `on run {msg, ttl, sub, snd}
  if snd is "" then
    display notification msg with title ttl subtitle sub
  else
    display notification msg with title ttl subtitle sub sound name snd
  end if
end run`;

/**
 * Fire a macOS Notification Centre banner.
 *
 * Never throws: a notification failure (permissions denied, no GUI session)
 * must not take down the watcher, and the terminal output is the baseline
 * alert regardless.
 */
export async function macNotify({ title, subtitle = '', message, sound = 'Glass' }) {
  if (process.platform !== 'darwin') return false;
  try {
    await run('osascript', ['-e', NOTIFY_SCRIPT, message, title, subtitle, sound ?? ''], {
      timeout: 10_000,
    });
    return true;
  } catch (err) {
    console.error(color.yellow(`  ! macOS notification failed: ${err.message.split('\n')[0]}`));
    return false;
  }
}

export function timestamp(d = new Date()) {
  return d.toLocaleTimeString('en-CA', { hour12: false });
}

/** Loud, hard-to-miss terminal block for a match, plus the terminal bell. */
export function printMatch(target, runs, { bell = true } = {}) {
  const head = ` SEATS AVAILABLE  ${target.movie ?? 'showtime ' + target.showtimeId} `;
  console.log('');
  console.log(color.green(color.bold(color.invert(head))));
  if (target.theatre) console.log(`  ${color.dim(target.theatre)}`);
  for (const r of runs) {
    const n = r.seats.length;
    const special = r.types.some((t) => t !== 'Standard')
      ? color.yellow('  (accessible seating)')
      : '';
    console.log(
      `  ${color.bold(color.green(`Row ${r.row}`))}  ${color.bold(r.seats.join(', '))}  ` +
        `${color.dim(`[${n} together]`)}${special}`
    );
  }
  console.log(`  ${color.cyan(target.url)}`);
  console.log('');
  if (bell && isTTY) process.stdout.write(BEL);
}

/** One-line-per-showtime heartbeat so you can see it is alive and polling. */
export function printStatus(target, result) {
  const rows = result.freeByRow.length
    ? result.freeByRow.map((r) => `${color.bold(r.row)}:${r.labels.length}`).join(' ')
    : color.dim('none');
  const flags = [
    result.isSoldOut ? color.red('SOLD OUT') : null,
    result.isPostShowtime ? color.dim('PAST') : null,
  ]
    .filter(Boolean)
    .join(' ');
  const matched = result.runs.length
    ? color.green(`${result.runs.length} match${result.runs.length === 1 ? '' : 'es'}`)
    : color.dim('no match');
  console.log(
    `${color.dim(timestamp())} ${color.bold(String(target.showtimeId))} ` +
      `${color.dim('free')} ${String(result.freeCount).padStart(3)} ${color.dim('|')} ${rows} ` +
      `${color.dim('|')} ${matched}${flags ? ' ' + flags : ''}`
  );
}
