// -----------------------------------------------------------------------------
// The cumulative index built from a counter of the day (src/daily.js), alone
// and with the guard behind it, counting what the core would count (every
// rise of the published index). Rule: every doubt counts less, never more.
// Times are local (Europe/Paris, CEST in mid-October: UTC+2).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DailyIndex, localParts } from '../src/daily.js';
import { IndexGuard } from '../src/guard.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const LIMITS = {
  resetMaxKwh: 36,
  undoWithinMs: 3 * HOUR,
  maxKw: 36,
  slackKwh: 0.5,
  windowBefore: HOUR,
  windowAfter: 3 * HOUR,
  timeZone: 'Europe/Paris',
};
const fresh = (saved, loadedAt) => new DailyIndex(saved, LIMITS, loadedAt);
const r3 = (v) => (v === undefined ? undefined : Math.round(v * 1000) / 1000);
/** Local time in Paris on 2026-10-(12 + day), "HH:MM" (CEST, UTC+2). */
const at = (day, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return Date.UTC(2026, 9, 12 + day, h - 2, m);
};

/** daily.js then guard.js, as src/app.js publish() chains them; `counted` as the core counts. */
function pipeline() {
  let daily = fresh();
  let guard = new IndexGuard(undefined, undefined, 0, { maxKw: 36, slackKwh: 0.5 });
  let core;
  let counted = 0;
  return {
    read(today, time) {
      const built = daily.read(today, time, guard.last);
      const total = r3(built);
      const ok = total !== undefined && guard.accept(total, time);
      const sent = ok ? total : guard.held ? guard.last?.value : undefined;
      if (sent !== undefined) {
        if (core !== undefined && sent > core) counted += sent - core;
        core = sent;
      }
      return sent;
    },
    restart(time) {
      daily = fresh(JSON.parse(JSON.stringify(daily.state())), time);
      const g = JSON.parse(JSON.stringify(guard.state()));
      guard = new IndexGuard(g.last, g, time, { maxKw: 36, slackKwh: 0.5 });
    },
    /** One read a minute from `from` to `to` (local, same day), the counter rising linearly. */
    ramp(day, from, to, kwhFrom, kwhTo) {
      const a = at(day, from);
      const b = at(day, to);
      for (let t = a; t <= b; t += MINUTE) {
        this.read(r3(kwhFrom + ((kwhTo - kwhFrom) * (t - a)) / (b - a)), t);
      }
    },
    get counted() {
      return r3(counted);
    },
  };
}

/** A day up to 14:00 with 20 kWh, after a new day at 00:05. */
function dayUntil2pm(kwh = 20, until = '14:00') {
  const p = pipeline();
  p.read(5, at(-1, '23:00'));
  p.read(0, at(0, '00:05'));
  p.ramp(0, '00:06', until, 0, kwh);
  return p;
}

test('local parts in the time zone; an unknown zone falls back to Paris', () => {
  assert.deepEqual(localParts(at(0, '00:30'), 'Europe/Paris'), { date: '2026-10-12', hour: 0 });
  assert.deepEqual(localParts(at(0, '23:30'), 'Europe/Paris'), { date: '2026-10-12', hour: 23 });
  assert.deepEqual(localParts(at(0, '00:30'), 'Nowhere/Else'), { date: '2026-10-12', hour: 0 });
});

test('daily index: the same day, it follows the counter; the first read starts from it', () => {
  const daily = fresh();
  assert.equal(daily.read(2, at(0, '10:00')), 2);
  assert.equal(daily.read(2, at(0, '10:01')), 2, 'unchanged');
  assert.equal(daily.read(2.5, at(0, '10:02')), 2.5);
  assert.equal(daily.read(4, at(0, '10:03')), undefined, '1.5 kWh in a minute: a jump');
  for (const bad of [undefined, null, NaN, -1, '3', Infinity]) {
    assert.equal(daily.read(bad, at(0, '10:04')), undefined, String(bad));
  }
  assert.equal(daily.read(4, NaN), undefined);
});

test('daily index: an index already in Gladys goes on from its value, never from 0', () => {
  const daily = fresh();
  assert.equal(daily.read(5, at(0, '10:00'), { value: 1000 }), 1000);
  assert.equal(daily.read(6, at(0, '10:30')), 1001);
  assert.equal(fresh().read(5, at(0, '10:00'), { value: 0 }), 5, 'a value of 0 is no reference');
});

test('daily index: a new day around midnight goes on from the index, never drops', () => {
  const daily = fresh();
  assert.equal(daily.read(15, at(0, '23:58')), 15);
  assert.equal(r3(daily.read(0.02, at(1, '00:01'))), 15, 'the first value of a day is not counted');
  assert.equal(r3(daily.read(3, at(1, '02:00'))), 17.98);
  assert.equal(r3(daily.read(20, at(1, '23:59'))), 34.98);
  // The next midnight, read at 00:00.
  assert.equal(r3(daily.read(0.1, at(2, '00:00'))), 34.98);
  assert.equal(r3(daily.read(1, at(2, '01:00'))), 35.88);
  // Behind: its midnight at 02:30 ours.
  daily.read(10, at(2, '23:00'));
  assert.equal(r3(daily.read(11, at(3, '02:00'))), 45.88, 'not yet its midnight');
  assert.equal(r3(daily.read(0.2, at(3, '02:30'))), 45.88);
});

test('S1: a reboot at 14:01, 0 for 61 min, then the day back: counted once', () => {
  const p = dayUntil2pm();
  for (let m = 1; m <= 61; m += 1) {
    assert.equal(p.read(0, at(0, '14:00') + m * MINUTE), undefined, 'no index');
  }
  p.read(20.05, at(0, '15:03'));
  assert.equal(p.counted, 20.05);
});

test('S1b: one 0, unreachable 70 min, back with 1 kWh more: counted once', () => {
  const p = dayUntil2pm();
  p.read(0, at(0, '14:01'));
  p.read(21, at(0, '15:11'));
  assert.equal(p.counted, 21);
});

test('S1c: the inverter clock lost (2 h of 0), then fixed: counted once', () => {
  const p = dayUntil2pm(18, '13:00');
  for (let m = 1; m <= 120; m += 5) p.read(0, at(0, '13:00') + m * MINUTE);
  p.read(24, at(0, '15:01'));
  assert.equal(p.counted, 24);
});

test('S1d: a glitch to 0.01, then a 6 h pause, then back: counted once', () => {
  const p = dayUntil2pm(30, '13:00');
  p.read(0.01, at(0, '13:01'));
  p.read(36, at(0, '19:01'));
  assert.equal(p.counted, 36);
});

test('S1e: a 20-min freeze at 0 in the day: counted once', () => {
  const p = dayUntil2pm(10, '13:00');
  for (let m = 1; m <= 20; m += 1) p.read(0, at(0, '13:00') + m * MINUTE);
  p.read(10.1, at(0, '13:21'));
  assert.equal(p.counted, 10.1);
});

test('S2: a glitch kept in /data, a restart 90 min later, the counter back: counted once', () => {
  const p = dayUntil2pm();
  p.read(0, at(0, '14:01'));
  p.restart(at(0, '15:30'));
  p.read(21, at(0, '15:31'));
  assert.equal(p.counted, 21);
});

test('S4: a wall clock set back gives no index and moves nothing', () => {
  const daily = fresh();
  daily.read(15, at(0, '14:00'));
  assert.equal(daily.read(0, at(0, '12:00')), undefined, 'before the last value taken');
  assert.equal(daily.read(16, at(0, '13:00')), undefined);
  assert.equal(r3(daily.read(16, at(0, '14:30'))), 16);
  // A date of /data in the future is brought back to the time of loading.
  const saved = JSON.parse(JSON.stringify(daily.state()));
  saved.readAt = at(5, '00:00');
  const again = fresh(saved, at(0, '15:00'));
  assert.equal(again.state().readAt, at(0, '15:00'));
  assert.equal(r3(again.read(16.5, at(0, '15:30'))), 16.5);
  // A drop at 00:30 with a reference read "in the future" is no new day.
  const night = fresh();
  night.read(10, at(0, '23:30'));
  assert.equal(night.read(0, at(0, '22:00')), undefined);
});

test('a jump is never taken, nor confirmed by time', () => {
  const daily = fresh();
  daily.read(10, at(0, '12:00'));
  assert.equal(daily.read(40, at(0, '12:01')), undefined);
  for (let m = 2; m <= 600; m += 1) {
    assert.equal(daily.read(40, at(0, '12:00') + m * MINUTE), undefined, `minute ${m}`);
  }
  assert.equal(r3(daily.read(10.2, at(0, '22:01'))), 10.2, 'back to the real level');
});

test('a glitch to 0 at midnight is undone: too fast, or straight back to the same value', () => {
  // Too fast: 20 kWh back in 20 minutes after a 0.
  const fast = pipeline();
  fast.ramp(0, '20:00', '23:10', 17, 20);
  for (let m = 1; m <= 19; m += 1) fast.read(0, at(0, '23:10') + m * MINUTE);
  fast.read(20.01, at(0, '23:30'));
  assert.equal(fast.counted, 3.01);
  // Straight back to exactly the same value after 2 h unreachable (36 kW would allow it).
  const frozen = pipeline();
  frozen.ramp(0, '20:00', '23:10', 17, 20);
  frozen.read(0, at(0, '23:11'));
  frozen.read(20, at(1, '01:11'));
  assert.equal(frozen.counted, 3);
  // A real new day climbs through the old value: never undone.
  const real = pipeline();
  real.read(5, at(0, '23:50'));
  real.read(0, at(1, '00:01'));
  real.ramp(1, '00:02', '02:00', 0.1, 8);
  assert.equal(real.counted, 8);
});

test('a cut across midnight: the first drop after it is a new day', () => {
  const p = pipeline();
  p.ramp(0, '18:00', '20:00', 10, 12);
  p.read(3, at(1, '09:00'));
  assert.equal(p.counted, 2, '2 kWh in the evening; the night and the first value of the day lost');
});

test('production in the evening: flat after sunset, glitches, the real night', () => {
  const p = pipeline();
  p.ramp(0, '08:00', '19:00', 0.01, 12);
  for (let t = at(0, '19:01'); t < at(0, '21:00'); t += MINUTE) p.read(12, t);
  // A drop at 21:00, out of the midnight window: no index, back at 21:10.
  assert.equal(p.read(0, at(0, '21:00')), undefined);
  p.read(12, at(0, '21:10'));
  for (let t = at(0, '21:11'); t < at(0, '23:30'); t += MINUTE) p.read(12, t);
  // A glitch to 0 at 23:30 (in the window, taken as a new day), back at 23:45.
  p.read(0, at(0, '23:30'));
  p.read(12, at(0, '23:45'));
  assert.equal(p.counted, 11.99);
  // The real midnight: 0 all night, the sun at 08:00.
  p.read(0, at(1, '00:00'));
  for (let t = at(1, '00:01'); t < at(1, '08:00'); t += 10 * MINUTE) p.read(0, t);
  p.ramp(1, '08:00', '12:00', 0.01, 6);
  assert.equal(p.counted, 17.99);
});

test('a real reset in the day counts less, and the next midnight still works', () => {
  const p = dayUntil2pm();
  // The inverter really starts again from 0 at 14:01 and counts 4 kWh by 18:00.
  p.ramp(0, '14:01', '18:00', 0, 4);
  // Nothing of it counted (it never goes back above 20), but the night works.
  p.read(0.1, at(1, '00:05'));
  p.ramp(1, '00:06', '02:00', 0.1, 2);
  assert.equal(p.counted, 21.9, 'the first value of the new day (0.1) not counted');
});

// --- Approval of review 1 (scenarios2.mjs): N1, N2, N2b, N4, N4b, N5 ---------------

/** Yesterday 5 kWh, a new day at 00:00, then `total` kWh a day read every minute up to `until`. */
function approvalDay(total, until) {
  const p = pipeline();
  p.read(5, at(-1, '21:00'));
  p.read(0, at(0, '00:00'));
  const [h, m] = until.split(':').map(Number);
  for (let i = 1; i <= h * 60 + m; i += 1)
    p.read(r3((total * i) / 1440), at(0, '00:00') + i * MINUTE);
  return p;
}
const atMost = (counted, real) => assert.ok(counted <= real + 1e-9, `${counted} > ${real}`);

test('N1: a 0 at 23:05, the counter unread 45 min, back near the day: counted once', () => {
  const p = approvalDay(20, '23:04');
  p.read(0, at(0, '23:05'));
  p.read(19.6, at(0, '23:50'));
  for (let m = 51; m <= 59; m += 1) p.read(r3(19.6 + (m - 50) * 0.01), at(0, '23:00') + m * MINUTE);
  p.read(0, at(1, '00:00'));
  p.read(0.3, at(1, '00:30'));
  atMost(p.counted, 20.29);
  assert.equal(p.counted, 19.99);
});

test('N2: a stale low value (8) at 23:59 then the real midnight: no fictive kWh, nothing held', () => {
  const p = approvalDay(20, '23:58');
  p.read(8, at(0, '23:59'));
  p.read(0, at(1, '00:00'));
  for (let m = 1; m <= 60; m += 1) p.read(r3(m * 0.01), at(1, '00:00') + m * MINUTE);
  atMost(p.counted, 20.6);
  assert.equal(p.counted, 20.572);
});

test('N2b: a stale low value (0.9) at 23:59 then the real midnight: counted once', () => {
  const p = approvalDay(20, '23:58');
  p.read(0.9, at(0, '23:59'));
  p.read(0, at(1, '00:00'));
  p.read(0.3, at(1, '00:30'));
  assert.equal(p.counted, 20.272);
});

test('N4: a 0 at 23:11, back 30 min later just under the day: no new day taken again', () => {
  const p = approvalDay(20, '23:10');
  p.read(0, at(0, '23:11'));
  assert.equal(p.read(19.25, at(0, '23:41')), undefined, 'under the day before: no index');
  p.read(0, at(1, '00:00'));
  p.read(0.5, at(1, '00:30'));
  atMost(p.counted, 20.5);
  assert.equal(p.counted, 19.806);
});

test('N4b: a 0 at 23:11, back 30 min later just above the day: counted once', () => {
  const p = approvalDay(20, '23:10');
  p.read(0, at(0, '23:11'));
  p.read(19.4, at(0, '23:41'));
  p.read(0, at(1, '00:00'));
  p.read(0.5, at(1, '00:30'));
  assert.equal(p.counted, 19.9);
});

test('N5: the wall clock jumps 3 h forward into the window with a 0: the counter followed', () => {
  const p = approvalDay(20, '20:30');
  p.read(0, at(0, '23:31'));
  p.read(17.2, at(0, '23:32'));
  // Exactly what the counter of the day says (17.2 since midnight), never a day twice.
  assert.equal(p.counted, 17.2);
});
// --- Approval round 3 (R4): a night reboot of the inverter is ONE incident -----------

test('N6: unread 10 min, a 0 at 23:10, unread 45 min, back near the day: counted once', () => {
  const p = approvalDay(20, '23:00');
  p.read(0, at(0, '23:10'));
  p.read(19.6, at(0, '23:55'));
  for (let m = 56; m <= 59; m += 1) p.read(r3(19.6 + (m - 55) * 0.01), at(0, '23:00') + m * MINUTE);
  p.read(0, at(1, '00:00'));
  p.read(0.3, at(1, '00:30'));
  atMost(p.counted, 19.94);
});

test('N6b: unread 10 min, a stale 12, unread 15 min, back: counted once', () => {
  const p = approvalDay(20, '23:00');
  p.read(12, at(0, '23:10'));
  p.read(19.4, at(0, '23:25'));
  p.read(0, at(1, '00:00'));
  p.read(0.3, at(1, '00:30'));
  atMost(p.counted, 19.7);
});

test('N6c: the same across the local midnight, the inverter 1 h behind: counted once', () => {
  const p = approvalDay(20, '23:00');
  p.read(0, at(0, '23:50'));
  p.read(19.9, at(1, '00:40'));
  p.read(0, at(1, '01:00'));
  p.read(0.3, at(1, '01:30'));
  atMost(p.counted, 20.2);
});

test('a real cut across midnight (local day changed, over 1 h unread) is still a new day', () => {
  const p = pipeline();
  p.ramp(0, '18:00', '22:00', 10, 14);
  p.read(1, at(1, '07:00'));
  p.read(1.5, at(1, '07:10'));
  p.read(2, at(1, '07:30'));
  assert.equal(p.counted, 5, '4 kWh in the evening, 1 kWh after the first value of the day');
});
// --- Before publication: N9b, N11 (a cut only out of the window, monotonic gap) -------

test('N9b: a 105-min cut, a 0 at 00:15 (inverter 1 h behind), unread 43 min, back: counted once', () => {
  const p = approvalDay(20, '22:30');
  p.read(0, at(1, '00:15'));
  p.read(19.4, at(1, '00:58'));
  p.read(0, at(1, '01:00'));
  p.read(0.3, at(1, '01:30'));
  atMost(p.counted, 19.7);
});

test('N11: the wall clock jumps 3 h forward, a 0, unread 40 min, back: no forged cut', () => {
  const p = approvalDay(20, '22:00');
  p.read(0, at(1, '01:00'));
  p.read(18.6, at(1, '01:40'));
  atMost(p.counted, 18.6);
});

test('a cut is measured on the monotonic clock when the app gives it', () => {
  // Out of the window (05:00), the local day changed, 7 h on the wall clock
  // but 1 min on the monotonic one: no cut, the gap rule still applies.
  const daily = fresh();
  daily.read(18, at(0, '22:00'));
  assert.equal(r3(daily.read(0, at(1, '05:00'), undefined, { elapsedMs: MINUTE })), 18);
  assert.equal(daily.state().undo.cut, false);
  // Back after a gap to 17 (at least half the day before): the new day is undone,
  // then taken again (the local day changed) with the index unchanged: nothing counted.
  assert.equal(r3(daily.read(17, at(1, '05:10'), undefined, { elapsedMs: 10 * MINUTE })), 18);
  // The same with 7 h on the monotonic clock: a real cut.
  const real = fresh();
  real.read(18, at(0, '22:00'));
  real.read(0, at(1, '05:00'), undefined, { elapsedMs: 7 * HOUR });
  assert.equal(real.state().undo.cut, true);
});
test('the state survives a restart through JSON; a broken one is dropped', () => {
  const daily = fresh();
  daily.read(15, at(0, '23:59'));
  daily.read(0.1, at(1, '00:01'));
  const again = fresh(JSON.parse(JSON.stringify(daily.state())), at(1, '00:02'));
  assert.equal(r3(again.read(0.2, at(1, '00:03'))), 15.1);
  assert.equal(fresh({ offset: 'x' }).state(), null);
  assert.equal(fresh().state(), null);
});

test('daily index and guard: three real days, every value taken, no jump, a minute lost a day', () => {
  const p = pipeline();
  let sent;
  for (let day = 0; day < 3; day += 1) {
    for (let m = 0; m < 24 * 60; m += 1) {
      sent = p.read(r3(m * 0.01), at(day, '00:00') + m * MINUTE);
    }
  }
  assert.equal(p.counted, 43.16, 'from the first value above 0');
  assert.equal(sent, 43.17);
});
