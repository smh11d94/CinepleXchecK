// Seat-map indexing and adjacency matching.

/** Seat types that are reserved for wheelchair users and their companions. */
const SPECIAL_TYPES = new Set(['Wheelchair', 'Companion']);

/** The three seating areas a layout payload can contain. */
const AREAS = ['standardSeats', 'dboxSeats', 'balconySeats'];

/** Trailing digits of a label: "F12" -> 12, "EW4" -> 4. Used only for display order. */
function seatNumber(label) {
  const m = String(label).match(/(\d+)\s*$/);
  return m ? Number(m[1]) : 0;
}

/**
 * Flatten a seat-layout payload into a seatId -> seat lookup.
 *
 * Rows with a null label are spacer rows carrying no seats and are skipped.
 * Seats are keyed by area+row because row labels are only unique within an area.
 */
export function buildSeatIndex(layout) {
  const index = new Map();
  for (const area of AREAS) {
    const rows = layout?.[area]?.rows ?? [];
    for (const row of rows) {
      if (row.label == null) continue; // spacer row
      for (const seat of row.seats ?? []) {
        index.set(seat.id, {
          id: seat.id,
          area,
          row: row.label,
          rowKey: `${area}|${row.label}`,
          label: seat.label,
          // Physical grid position. Adjacency is computed on this, never on the
          // label: column runs opposite to the seat number (F30 is column 0).
          column: seat.column,
          type: seat.type,
          number: seatNumber(seat.label),
        });
      }
    }
  }
  return index;
}

/**
 * Seats that are not Occupied.
 *
 * Deliberately inverted: any status other than "Occupied" counts as free, so a
 * status we haven't seen before (e.g. "Held") is surfaced rather than silently
 * dropped.
 */
export function freeSeats(seatIndex, availabilities) {
  const free = [];
  for (const [id, status] of Object.entries(availabilities ?? {})) {
    if (status === 'Occupied') continue;
    const seat = seatIndex.get(id);
    if (seat) free.push({ ...seat, status });
  }
  return free;
}

/** Group seats by row, preserving the order rows appear in the layout. */
export function groupByRow(seats) {
  const groups = new Map();
  for (const seat of seats) {
    if (!groups.has(seat.rowKey)) groups.set(seat.rowKey, []);
    groups.get(seat.rowKey).push(seat);
  }
  for (const list of groups.values()) list.sort((a, b) => a.number - b.number);
  return groups;
}

/**
 * Find every run of `minRun`+ seats sitting side by side in the same row.
 *
 * A gap in column numbers is a real aisle (row E of theatre 1405 has gaps at
 * 5->7 and 23->25), so a gap always breaks the run.
 */
export function findAdjacentRuns(seats, minRun) {
  const runs = [];
  for (const [, rowSeats] of groupByRow(seats)) {
    const byColumn = [...rowSeats].sort((a, b) => a.column - b.column);
    let current = [];
    const flush = () => {
      if (current.length >= minRun) runs.push(makeRun(current));
      current = [];
    };
    for (const seat of byColumn) {
      const prev = current[current.length - 1];
      if (prev && seat.column !== prev.column + 1) flush();
      current.push(seat);
    }
    flush();
  }
  // Biggest blocks first, then by row for stable output.
  runs.sort((a, b) => b.seats.length - a.seats.length || a.row.localeCompare(b.row));
  return runs;
}

function makeRun(seatsInRun) {
  const ordered = [...seatsInRun].sort((a, b) => a.number - b.number);
  return {
    row: ordered[0].row,
    area: ordered[0].area,
    seats: ordered.map((s) => s.label),
    ids: ordered.map((s) => s.id),
    columns: [...seatsInRun].map((s) => s.column).sort((a, b) => a - b),
    types: [...new Set(ordered.map((s) => s.type))],
  };
}

/**
 * Apply a `want` rule to this cycle's availability payload.
 *
 * Returns the matching runs plus the free-seat breakdown, which the CLI prints
 * even when nothing matches so you can see what the auditorium looks like.
 */
export function matchSeats(seatIndex, availability, want) {
  const minRun = Math.max(1, want.adjacentSeats ?? 1);
  const wantedRows = want.rows?.length
    ? new Set(want.rows.map((r) => String(r).toUpperCase()))
    : null; // no rows configured => every row is eligible

  const allFree = freeSeats(seatIndex, availability.seatAvailabilities);

  const eligible = allFree.filter((seat) => {
    if (wantedRows && !wantedRows.has(String(seat.row).toUpperCase())) return false;
    if (!want.allowSpecialSeats && SPECIAL_TYPES.has(seat.type)) return false;
    return true;
  });

  return {
    runs: findAdjacentRuns(eligible, minRun),
    freeCount: allFree.length,
    freeByRow: summariseByRow(allFree),
    isSoldOut: Boolean(availability.isSoldOut),
    isPostShowtime: Boolean(availability.isPostShowtime),
  };
}

/**
 * Per-row breakdown of free seats.
 *
 * Wheelchair spaces and companion seats are reported separately: a wheelchair
 * position is one wheelchair space plus one ordinary-looking companion chair,
 * so lumping them together reads as twice as many wheelchair seats as the seat
 * map actually shows.
 */
export function summariseByRow(seats) {
  const out = [];
  for (const [, rowSeats] of groupByRow(seats)) {
    const wheelchair = rowSeats.filter((s) => s.type === 'Wheelchair').length;
    const companion = rowSeats.filter((s) => s.type === 'Companion').length;
    out.push({
      row: rowSeats[0].row,
      labels: rowSeats.map((s) => s.label),
      wheelchair,
      companion,
      special: wheelchair + companion,
    });
  }
  return out.sort((a, b) => a.row.localeCompare(b.row));
}

export { SPECIAL_TYPES };
