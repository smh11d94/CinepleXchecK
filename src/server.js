import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTicketUrl } from './api.js';

/**
 * Contract version between this server and public/app.js.
 *
 * Bump whenever the request or response shape changes. The page compares it
 * against its own copy and tells you to restart, because Node does not reload
 * src/ while running — a server left up across an edit will happily serve the
 * new page to the browser while still running the old API.
 */
export const API_VERSION = 4;

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error('Request body too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Request body is not valid JSON.');
  }
}

/** Serve a file from public/, refusing anything that escapes the directory. */
async function serveStatic(res, urlPath) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC_DIR, rel === '/' || rel === '\\' ? 'index.html' : rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

/** Separators accepted between showtime IDs or pasted links. */
const SEPARATORS = /[\s,;]+/;

/**
 * Turn an add request into a list of showtimes to watch.
 *
 * Accepts one location ID with any number of showtime IDs, and/or any number of
 * pasted ticketing links, in a single call. Duplicates within the request are
 * collapsed so pasting an overlapping list is harmless.
 */
export function parseAddRequest(body) {
  const items = [];
  const seen = new Set();
  const add = (locationId, showtimeId) => {
    const key = `${locationId}/${showtimeId}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ locationId, showtimeId });
  };

  const urls = []
    .concat(body.urls ?? [], body.url ?? [])
    .flatMap((u) => String(u).split(SEPARATORS))
    .filter((u) => /^https?:/i.test(u));
  for (const u of urls) {
    const parsed = parseTicketUrl(u); // throws with a readable message on junk
    add(parsed.locationId, parsed.showtimeId);
  }

  const showtimes = []
    .concat(body.showtimeIds ?? [], body.showtimeId ?? [])
    .flatMap((v) => String(v).split(SEPARATORS))
    .filter(Boolean);

  if (showtimes.length) {
    const locationId = String(body.locationId ?? '').trim();
    if (!locationId) throw new Error('A location ID is required.');
    for (const showtimeId of showtimes) add(locationId, showtimeId);
  }

  if (!items.length) throw new Error('Enter at least one showtime ID.');
  return items;
}

/**
 * Local control panel for the watcher.
 *
 * Binds to 127.0.0.1 only — this exposes an endpoint that makes outbound
 * requests on your behalf, so it must not be reachable from the network.
 */
export function createControlServer({ watcher, onChange }) {
  /** Open SSE connections. Each gets every watcher event as it happens. */
  const clients = new Set();

  const stateOf = () => ({ ...watcher.getState(), apiVersion: API_VERSION });

  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      // A dead socket must not take down the loop.
      try {
        res.write(frame);
      } catch {
        clients.delete(res);
      }
    }
  };

  watcher.on('target', (t) => broadcast('target', t));
  watcher.on('alert', (a) => broadcast('alert', a));
  watcher.on('gone', (g) => broadcast('gone', g));
  watcher.on('cycle', (c) => broadcast('cycle', c));
  watcher.on('scheduled', (x) => broadcast('scheduled', x));
  watcher.on('log', (l) => broadcast('log', l));

  const persist = async () => {
    try {
      await onChange?.();
    } catch (err) {
      broadcast('log', { level: 'warn', message: `Could not save config: ${err.message}`, at: new Date().toISOString() });
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;

    try {
      if (path === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(`event: state\ndata: ${JSON.stringify(stateOf())}\n\n`);
        clients.add(res);
        // Comment frames keep intermediaries from closing an idle stream.
        const ping = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {
            /* cleaned up on close */
          }
        }, 20_000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }

      if (path === '/api/state' && req.method === 'GET') {
        return sendJson(res, 200, stateOf());
      }

      if (path === '/api/targets' && req.method === 'POST') {
        const body = await readBody(req);
        const items = parseAddRequest(body).map((it) => ({ ...it, want: body.want ?? null }));
        const { added, failed } = await watcher.addTargets(items);
        // Persist and broadcast once for the whole batch rather than per item.
        if (added.length) {
          await persist();
          broadcast('state', stateOf());
        }
        // Every single one failing is a client error worth surfacing as such.
        return sendJson(res, added.length ? 201 : 400, {
          added,
          failed,
          error: added.length ? undefined : failed[0]?.error,
        });
      }

      // /api/targets/<locationId>/<showtimeId>
      const targetMatch = path.match(/^\/api\/targets\/([^/]+)\/([^/]+)$/);
      if (targetMatch) {
        const key = `${decodeURIComponent(targetMatch[1])}/${decodeURIComponent(targetMatch[2])}`;

        if (req.method === 'DELETE') {
          watcher.removeTarget(key);
          await persist();
          broadcast('state', stateOf());
          return sendJson(res, 200, { removed: key });
        }

        if (req.method === 'PATCH') {
          const body = await readBody(req);
          let updated;
          if (body.paused !== undefined) updated = watcher.setPaused(key, body.paused);
          if (body.want !== undefined) updated = await watcher.setTargetWant(key, body.want);
          await persist();
          broadcast('state', stateOf());
          return sendJson(res, 200, updated ?? stateOf());
        }
      }

      if (path === '/api/settings' && req.method === 'PUT') {
        const body = await readBody(req);
        const settings = watcher.updateSettings(body);
        await persist();
        broadcast('state', stateOf());
        return sendJson(res, 200, settings);
      }

      if (path === '/api/check' && req.method === 'POST') {
        await watcher.runCycle();
        broadcast('state', stateOf());
        return sendJson(res, 200, stateOf());
      }

      if (req.method === 'GET') return serveStatic(res, path);

      return sendJson(res, 405, { error: `${req.method} not allowed for ${path}` });
    } catch (err) {
      // Validation failures (bad id, duplicate) are the common case here, so
      // 400 with the message is more useful to the UI than a generic 500.
      return sendJson(res, 400, { error: err.message });
    }
  });

  return server;
}
