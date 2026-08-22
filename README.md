# Cineplex Seat Watcher

Polls Cineplex showtimes every 30 seconds and alerts you with a macOS notification
the moment seats you actually want become available.

Seats get released all the time when people cancel or change bookings — this catches
them without you refreshing the page.

## Quick start

```bash
node index.js --serve
```

Then open **http://127.0.0.1:8787** and add showtimes in the browser.

No dependencies, no install step. Requires Node 18+ (built-in `fetch`).
Press `Ctrl+C` to stop.

## The control panel

Two tabs in the header.

### Watching (main screen)

- A **countdown ring** in the header shows how long until the next check. The server
  publishes the real due time, because jitter means it can't be derived from the poll
  interval alone. A hairline under the header fills as the wait elapses.
- **Stat tiles** — showtimes watched, total free seats, how many showtimes currently
  match, and when the last check ran plus how long it took (e.g. `150ms · 6 in parallel`). The Matching tile turns green when it's non-zero,
  and the Watching tab gets a badge.
- **Showtimes grouped by theatre**, each theatre inside one heavier border. On a wide
  window the theatres sit side by side in two columns; they stack when it's narrower.
- **A match turns the whole card green** and pulses twice, listing the exact seat blocks
  with a **Book now** button. Every card also has an **↗** link that opens that showtime
  on Cineplex at any time, matched or not, plus pause (⏸) and remove (×).
- **Row tags** like `A ×10` show how many seats are free in each row — the `×` is there
  because a bare `A 10` reads like the seat label "A10". Hover a tag for the actual seat
  labels. Rows you're watching are outlined.
- **Activity** — a collapsible log of checks, alerts and errors.

### Settings

- **Theatres you're watching** — every location you've added, with the showtimes already
  being watched there and an inline field to add more. This is the quick path: you never
  re-type a location ID for a theatre you're already watching. Errors stay on the row
  they came from. (Hidden until you're watching something.)
- **Add another theatre** — for a location that isn't in the list yet. One **Location ID**
  and as many **Showtime IDs** as you like, separated by commas or spaces
  (`537674, 537675, 537676`). Or expand *Paste links instead* and drop in several
  ticketing URLs, one per line — the IDs are pulled out for you. Each showtime is verified
  against Cineplex as it's added, so a wrong ID is rejected immediately with a readable
  message rather than silently never matching. If only some IDs are bad the good ones are
  still added, and each failure is listed.
- **What should alert you** — seats together, which rows, how often to check, how many
  showtimes to fetch in parallel, and whether accessible seats count. Row buttons are generated from the auditoriums you're actually
  watching, so you only ever see rows that exist.

Everything you change is written straight back to `config.json`, so the watch list
survives a restart and the terminal mode below reads the same file.

Alerts arrive three ways at once: a macOS notification, a toast in the page, and a
browser notification (allow it when prompted after your first **Save rules**).

The server binds to `127.0.0.1` only — it is reachable from your Mac and nowhere else.

> **After editing anything in `src/`, restart the server.** Files under `public/` are
> read from disk on every request, but `src/` is loaded into the Node process at
> startup — so a server left running across an edit serves the new page from the old
> API. The page detects that mismatch and shows a banner telling you to restart.

## Configuring by hand

You can skip the UI and edit [`config.json`](config.json) directly:

```json
{
  "pollSeconds": 30,
  "maxConcurrency": 6,
  "want": {
    "adjacentSeats": 2,
    "rows": ["F", "G", "H", "I", "J"],
    "allowSpecialSeats": false
  },
  "notify": { "macos": true, "sound": "Glass" },
  "targets": [
    "https://www.cineplex.com/ticketing/preview?locationId=1405&showtimeId=537674&dbox=false"
  ]
}
```

| Setting | Meaning |
| --- | --- |
| `pollSeconds` | Seconds between checks. 30 is a good default. |
| `maxConcurrency` | How many showtimes are fetched at once. Default 6, max 16. |
| `want.adjacentSeats` | How many seats must be **side by side** to count. `2` = a pair. `1` = any single seat. |
| `want.rows` | Row letters you'd accept. Omit or use `[]` to accept every row. |
| `want.allowSpecialSeats` | `false` skips wheelchair/companion seats, which often sit free and would otherwise alert constantly. |
| `notify.macos` | `false` to use terminal output only. |
| `notify.sound` | Any macOS alert sound name (`Glass`, `Ping`, `Submarine`, …). |
| `targets` | Ticketing links, pasted verbatim — the location and showtime ids are read out of the URL. |

### Watching one showtime differently

A target can be an object carrying its own `want` block, which overrides the global one:

```json
"targets": [
  "https://www.cineplex.com/ticketing/preview?locationId=1405&showtimeId=537674&dbox=false",
  {
    "url": "https://www.cineplex.com/ticketing/preview?locationId=1405&showtimeId=537676&dbox=false",
    "want": { "adjacentSeats": 4, "rows": ["G", "H"] }
  }
]
```

## Commands

```bash
node index.js --serve         # web control panel (default port 8787)
node index.js                 # watch in the terminal, no browser
node index.js --once          # single check, then exit
node index.js --test-alert    # confirm notifications work

node index.js --serve --port 9000
node index.js --config PATH   # use a different config file
```

`--serve` and the terminal mode do exactly the same crawling and share the same
`config.json`; the only difference is whether you get a UI.

## Terminal output

A heartbeat line per showtime per cycle, showing free seats broken down by row:

```
12:50:17 537674 free  24 | A:14 B:2 C:1 E:7 | no match
```

And when seats you want open up, a highlighted block plus a notification:

```
 SEATS AVAILABLE  The Odyssey: The IMAX Experience® in 70MM Film
  Cineplex Cinemas Langley
  Row F  F12, F13  [2 together]
  https://www.cineplex.com/ticketing/preview?locationId=1405&showtimeId=537674&dbox=false
```

Click the link to book. **The watcher only reports — it never holds or buys seats.**

### Alerts don't repeat

Once it alerts you about a pair, it stays quiet about that same pair. You'll only be
alerted again if the set of matching seats actually changes (more seats open, or a
different block appears). If the seats get taken again it prints a quiet note.

If no banner appears, run `node index.js --test-alert` and allow notifications for your
terminal app under **System Settings → Notifications**.

## How it works

The `/ticketing/preview` page is a Next.js shell that holds no seat data. It fetches
from Cineplex's public JSON API, which this tool calls directly:

- `…/v1/theatre/{location}/showtime/{showtime}/seat-layout` — the seat map, fetched **once**
- `…/seat-availability?preview=true` — live availability, ~5.5 KB, the only repeated call

No browser or scraping is involved, so a cycle costs far less traffic than opening the
page once.

**Adjacency** is computed from each seat's physical `column`, never from its label — a gap
in column numbers is a real aisle, so seats either side of one are never reported as
"together". Seat labels also run opposite to columns (`F30` is column 0).

### Parallel checks

Showtimes are polled through a bounded worker pool (`src/pool.js`): a fixed set of workers
pull from a shared queue, so a slow showtime never leaves the others idle — which is what
happens with fixed-size batches, where every batch waits for its slowest member.

Measured against the live API with 6 showtimes across 2 theatres:

| Concurrency | Startup | Cycle (avg of 3) |
| --- | --- | --- |
| 1 | 2434 ms | 1198 ms |
| 3 | 500 ms | 310 ms |
| 6 *(default)* | 327 ms | 150 ms |

The earlier sequential version also slept 1 s between showtimes, so a 6-showtime cycle took
roughly 7 s. The pool caps the burst instead, which is both faster and gentler than a fixed
delay — raise `maxConcurrency` for a long watch list, lower it if you ever see HTTP 429.

Because showtimes now finish in whatever order the network returns them, the UI sorts by
location then showtime before rendering — otherwise cards would shuffle on every restart.

There is no global lock. Separate showtimes touch disjoint state (their own fields, and a
tracker entry keyed by showtime), so the only real hazard is two overlapping checks of the
*same* showtime. `Watcher#checkTarget` prevents that by returning the in-flight promise
rather than issuing a second request, and `addTarget` reserves its key before awaiting so
parallel adds of the same showtime cannot both succeed.

In `--serve` mode the same engine runs inside a small Node HTTP server. The browser gets
live updates over Server-Sent Events (`/api/events`), so cards and alerts appear the moment
a check finishes rather than on a UI refresh timer.

```
public/          the control panel (plain HTML/CSS/JS, no build step)
src/watcher.js   the crawl engine — owns the target list and the poll loop
src/pool.js      bounded-concurrency worker pool
src/server.js    HTTP + JSON API + SSE, bound to 127.0.0.1
src/match.js     adjacency matching
src/api.js       Cineplex API client
src/store.js     reads and writes config.json
```

## Notes

- The API key in [`src/api.js`](src/api.js) is the public client key Cineplex ships in its
  own site JavaScript. If it's ever rotated the symptom is a sudden `401`; re-read it from
  a current page bundle and update that one constant.
- Failed requests back off per showtime (30s → 60s → 120s → 5min) and reset on success, so
  a blip never kills the watcher.
- Showtimes that have already started are dropped automatically.
