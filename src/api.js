// Cineplex public JSON API client.
//
// The /ticketing/preview page is a static Next.js shell; seat data is fetched
// client-side from these endpoints. The subscription key below is the public
// client key Cineplex ships in its own website JS bundles — we send it exactly
// as the site does. If Cineplex rotates it the symptom is a sudden 401; re-read
// it from a current page bundle and update this one constant.
const SUBSCRIPTION_KEY = 'dcdac5601d864addbc2675a2e96cb1f8';

const TICKETING_API = 'https://apis.cineplex.com/prod/ticketing/api';
const THEATRICAL_API = 'https://apis.cineplex.com/prod/cpx/theatrical/api';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const TIMEOUT_MS = 10_000;

/** Raised for HTTP-level failures so callers can inspect the status code. */
export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: {
      'Ocp-Apim-Subscription-Key': SUBSCRIPTION_KEY,
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      Origin: 'https://www.cineplex.com',
      Referer: 'https://www.cineplex.com/',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new HttpError(res.status, url);
  return res.json();
}

/**
 * Pull locationId/showtimeId out of a ticketing URL so users can paste links
 * verbatim instead of hand-entering ids.
 */
export function parseTicketUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Not a valid URL: ${url}`);
  }
  const locationId = parsed.searchParams.get('locationId');
  const showtimeId = parsed.searchParams.get('showtimeId');
  if (!locationId || !showtimeId) {
    throw new Error(
      `URL is missing locationId and/or showtimeId: ${url}\n` +
        '  Expected something like ' +
        'https://www.cineplex.com/ticketing/preview?locationId=1405&showtimeId=537674'
    );
  }
  return { locationId, showtimeId, url };
}

/** Static seat map for a showtime — fetch once, cache for the process lifetime. */
export function fetchSeatLayout(locationId, showtimeId) {
  return getJson(
    `${TICKETING_API}/v1/theatre/${locationId}/showtime/${showtimeId}/seat-layout`
  );
}

/** Live availability — this is the only call made every poll cycle (~5.5 KB). */
export function fetchAvailability(locationId, showtimeId) {
  return getJson(
    `${TICKETING_API}/v1/theatre/${locationId}/showtime/${showtimeId}` +
      '/seat-availability?preview=true'
  );
}

/** Movie title / theatre name, so alerts are readable. Static per showtime. */
export function fetchShowtimeMeta(locationId, showtimeId) {
  return getJson(
    `${THEATRICAL_API}/v1/theatres/${locationId}/showtimes/${showtimeId}?language=en-us`
  );
}

/** Canonical ticketing URL for a showtime, used when ids are entered directly. */
export function ticketUrl(locationId, showtimeId, dbox = false) {
  const q = new URLSearchParams({
    locationId: String(locationId),
    showtimeId: String(showtimeId),
    dbox: String(Boolean(dbox)),
  });
  return `https://www.cineplex.com/ticketing/preview?${q}`;
}
