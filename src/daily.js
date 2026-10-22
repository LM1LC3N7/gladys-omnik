// -----------------------------------------------------------------------------
// A cumulative index built from a counter of the day. Pure.
//
// Taken as it is from gladys-zeversolar 0.1.4 (src/daily.js, itself
// gladys-imeon's, approved after four review rounds; only these comments
// name Omnik). The Wi-Fi logger of an Omnik inverter gives its energy as a
// counter of the day (0.01 kWh), started again when the inverter wakes up in
// the morning; its lifetime counter (0.1 kWh, firmware-dependent) is not used
// (TODO.md "Decisions"). The Gladys energy monitoring needs a cumulative index (it
// counts the deltas), never a counter of the day: published as an index, it
// would drop to 0 every morning, the guard (src/guard.js) would hold every one
// of those drops, and the index would be stuck. So the index is built here:
//
//   index = offset + today
//
// where `offset` is the sum of the days already ended. Every doubt counts
// LESS, never more. The rules:
// - a rise of the counter is taken only when it is plausible since the last
//   value taken: at most `maxKw` × the time since that read (`readAt`, moved
//   by every value taken, an equal one included) + `slackKwh`. A larger rise
//   is a jump: no index, the counter of reference does not move, and
//   `readAt` moves anyway, so a jump is never confirmed by time;
// - a drop is a new day only around the local midnight (from `windowBefore`
//   before to `windowAfter` after it, in `timeZone`: the inverter's clock may
//   be a little off), once per night, or when the last value taken is from an
//   earlier local day (a cut across midnight), and only down to at most
//   `resetMaxKwh`. The index stays exactly where it was (`offset` takes the
//   difference): neither the first value of the new day nor what the
//   inverter counted between our last read and its midnight is counted (less;
//   a stale low value just before its midnight is never counted);
// - any other drop (a reboot, a clock lost, a glitch in the day) gives no
//   index, and nothing moves: the counter must come back above the last value
//   taken. What was counted meanwhile and is not back is lost (less);
// - a new day taken by mistake (a glitch to 0 near midnight) is undone when,
//   within `undoWithinMs`, the counter comes back faster than `maxKw` allows,
//   comes back straight to exactly the value of the day before (a frozen
//   counter), or is read after a gap (`gapMs`) back to at least half the day
//   before: a night reboot of the inverter (unread, 0 or stale, unread, back)
//   is ONE incident. Only exception: a real cut across midnight (a drop read
//   OUT of the midnight window, the local day changed since the last value
//   taken AND over an hour without reads before it, on the monotonic clock
//   when the app gives it). The night is then used: a value under the day before
//   gives no index until the counter passes it or the local day changes
//   (approval R1, R3, R4);
// - a second drop while the first new day may still be undone (a stale low
//   value before the inverter's midnight, then its real 0) undoes the first
//   one, the night free again, and is judged alone (approval R2);
// - a wall clock set back (a value read before the last one taken) gives no
//   index and moves nothing; a `readAt` read back from /data in the future is
//   brought back to the time of loading.
//
// Risk left near midnight: after a new day still undoable, a value read after
// a gap but under half the day before is taken as the new day's consumption
// (at most that value too much); after a real cut across midnight (a drop
// read after the window), a return to the day's level after another gap,
// slow enough for `maxKw`, would count the day before again: it needs an
// inverter whose midnight is later than the window, a cut, a counter near 0
// and a return.
//
// An Omnik inverter sleeps at night (no sun, no answer): its counter drops
// at sunrise, out of the midnight window, after hours without reads, the last
// value taken from the day before: the "earlier local day" rule takes it, as
// a real cut across midnight. That makes the "risk left" above a daily one
// here (every sunrise is a cut, the undo after a gap never applies): the app
// keeps the day before shown again out of this index (src/app.js `keptOut`:
// within 0.1 kWh (above or below) of the last value taken at sunrise, or of the value of the
// day before later that same day, both kept in /data), review 1 B1 and I1.
// Left: a day before shown more than 0.1 kWh from the last value read (above
// or below, review 2), or a
// wrong reading within the installation's margin (the app's `maxKw`).
//
// Whatever comes out still passes the IndexGuard, which holds any jump or
// drop of the built index.
// -----------------------------------------------------------------------------

const HOUR = 3_600_000;

export const DAILY_DEFAULTS = {
  resetMaxKwh: 36,
  undoWithinMs: 3 * HOUR,
  maxKw: 36,
  slackKwh: 0.5,
  windowBefore: HOUR,
  windowAfter: 3 * HOUR,
  /** More than this between two reads is a gap (3 polls). */
  gapMs: 3 * 60_000,
  timeZone: 'Europe/Paris',
};

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (value) => (typeof value === 'string' && DAY.test(value) ? value : null);

const formats = new Map();
const localPartsFormat = (timeZone) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });

/** The local date (YYYY-MM-DD) and hour (0-23) of `at` in `timeZone`. */
export function localParts(at, timeZone) {
  let format = formats.get(timeZone);
  if (!format) {
    try {
      format = localPartsFormat(timeZone);
    } catch {
      // An unknown time zone: the one of the inverters' home market.
      format = localPartsFormat(DAILY_DEFAULTS.timeZone);
    }
    formats.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(at).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}

function validState(saved, loadedAt) {
  if (
    !saved ||
    !finite(saved.offset) ||
    !finite(saved.today) ||
    saved.today < 0 ||
    !finite(saved.readAt)
  ) {
    return undefined;
  }
  const undo = saved.undo;
  // A date of /data in the future (a clock set back since) is brought back to now.
  const clamp = (at) => (finite(loadedAt) ? Math.min(at, loadedAt) : at);
  return {
    offset: saved.offset,
    today: saved.today,
    readAt: clamp(saved.readAt),
    readDay: day(saved.readDay),
    resetWindow: day(saved.resetWindow),
    undo:
      undo &&
      finite(undo.prevToday) &&
      finite(undo.prevReadAt) &&
      finite(undo.at) &&
      finite(undo.resetValue)
        ? {
            prevToday: undo.prevToday,
            prevReadAt: clamp(undo.prevReadAt),
            prevReadDay: day(undo.prevReadDay),
            prevResetWindow: day(undo.prevResetWindow),
            at: clamp(undo.at),
            resetValue: undo.resetValue,
            cut: undo.cut === true,
          }
        : null,
  };
}

export class DailyIndex {
  /**
   * `saved`: the state kept in /data (`state()`). `limits`: see
   * DAILY_DEFAULTS (a missing one takes its default). `loadedAt`: the time of
   * loading (a date of /data after it is brought back to it).
   */
  constructor(saved, limits = {}, loadedAt) {
    this.limits = { ...DAILY_DEFAULTS };
    for (const [key, value] of Object.entries(limits ?? {})) {
      if (value !== undefined && key in DAILY_DEFAULTS) this.limits[key] = value;
    }
    this.s = validState(saved, loadedAt);
  }

  /** What /data keeps. */
  state() {
    return this.s ? { ...this.s, undo: this.s.undo ? { ...this.s.undo } : null } : null;
  }

  local(at) {
    return localParts(at, this.limits.timeZone);
  }

  /** The night `at` belongs to (the date after its midnight), and whether `at` is in its window. */
  window(at) {
    const { windowBefore, windowAfter } = this.limits;
    const shifted = this.local(at + windowBefore);
    return {
      key: shifted.date,
      inside: shifted.hour * HOUR < windowBefore + windowAfter,
    };
  }

  take(today, at) {
    this.s.today = today;
    this.s.readAt = at;
    this.s.readDay = this.local(at).date;
    return this.s.offset + today;
  }

  /**
   * Undo the pending new day. `consume`: the night stays used (a glitch was
   * seen in it, a value under the day before gives no index until the
   * counter passes it or the local day changes); otherwise the night is free
   * again (a second drop: the real new day may still come).
   */
  undo({ consume }) {
    const { undo } = this.s;
    const night = this.s.resetWindow;
    this.s.offset -= undo.prevToday - undo.resetValue;
    this.s.today = undo.prevToday;
    this.s.readAt = undo.prevReadAt;
    this.s.readDay = undo.prevReadDay;
    this.s.resetWindow = consume ? night : undo.prevResetWindow;
    this.s.undo = null;
  }

  /**
   * The index for a counter of the day `today` (kWh) read at `at` (ms), or
   * undefined (no index for that read). `known`: the index Gladys holds
   * (`{ value }`), used only the very first time, so that an index already
   * in Gladys goes on from its value (never from 0). `elapsedMs`: the time
   * since the previous counter read on a monotonic clock (the wall clock
   * difference when unknown), for the cut across midnight.
   */
  read(today, at, known, { elapsedMs } = {}) {
    if (!finite(today) || today < 0 || !finite(at)) {
      return undefined;
    }
    const s = this.s;
    if (!s) {
      const base = known && finite(known.value) && known.value > 0 ? known.value - today : 0;
      this.s = { offset: base, today, readAt: at, readDay: null, resetWindow: null, undo: null };
      return this.take(today, at);
    }
    if (at < s.readAt) {
      // The wall clock went back: nothing taken, nothing moved.
      return undefined;
    }
    const { resetMaxKwh, undoWithinMs, maxKw, slackKwh, gapMs } = this.limits;
    if (s.undo && (at - s.undo.at > undoWithinMs || at < s.undo.at)) {
      s.undo = null;
    }
    if (s.undo && !s.undo.cut && at - s.readAt > gapMs && today >= s.undo.prevToday / 2) {
      // Any new day still undoable (but a real cut across midnight), then a
      // value read after a gap that is back to at least half the day before:
      // a night reboot of the inverter (unread, 0 or stale, unread, back) is
      // ONE incident, the new day a doubt, undone (back above the day before:
      // taken; under it: no index until it passes it or the local day changes).
      this.undo({ consume: true });
      return this.read(today, at, undefined, { elapsedMs });
    }
    if (
      s.undo &&
      s.today === s.undo.resetValue &&
      today > s.today &&
      Math.abs(today - s.undo.prevToday) < 0.0005
    ) {
      // Straight from the new day's value back to exactly the value of the day
      // before (a real new day climbs on its way): a frozen counter, undone.
      this.undo({ consume: true });
      return this.read(today, at, undefined, { elapsedMs });
    }
    if (today >= s.today) {
      const margin = (maxKw * (at - s.readAt)) / HOUR + slackKwh;
      if (today - s.today <= margin) {
        return this.take(today, at);
      }
      if (s.undo) {
        // Too fast for a new day: the new day was a glitch, undone; the night is used.
        this.undo({ consume: true });
        return this.read(today, at, undefined, { elapsedMs });
      }
      // A jump: never taken, never confirmed by time.
      s.readAt = at;
      s.readDay = this.local(at).date;
      return undefined;
    }
    // A drop: a new day, or a glitch.
    if (s.undo) {
      // A second drop while the first new day may still be undone (a stale
      // low value before the inverter's midnight, then its real 0): the first
      // one is undone, the night free again, and this drop judged alone.
      this.undo({ consume: false });
      return this.read(today, at, undefined, { elapsedMs });
    }
    const night = this.window(at);
    const laterDay = s.readDay !== null && this.local(at).date > s.readDay;
    const newDay =
      today <= resetMaxKwh && ((night.inside && s.resetWindow !== night.key) || laterDay);
    if (!newDay) {
      return undefined;
    }
    s.undo = {
      prevToday: s.today,
      prevReadAt: s.readAt,
      prevReadDay: s.readDay,
      prevResetWindow: s.resetWindow,
      at,
      resetValue: today,
      // A real cut across midnight: a drop read OUT of the midnight window,
      // the local day changed since the last value taken AND more than an hour
      // without reads before it, measured on the monotonic clock when the app
      // gives it (elapsedMs), so a wall clock jumping forward forges none.
      cut: laterDay && !night.inside && (finite(elapsedMs) ? elapsedMs : at - s.readAt) > HOUR,
    };
    // The index stays exactly where it was: the first value of the new day is
    // not counted (a stale low value before the inverter's midnight would be).
    s.offset += s.today - today;
    s.resetWindow = night.key;
    return this.take(today, at);
  }
}
