// -----------------------------------------------------------------------------
// 0.1.3: a house 7 h east of the container's time zone (Gladys left on UTC):
// the inverter wakes up and resets at 23:30 container time. The mark of the
// day before is dated by the night it starts; the day before shown again at
// the house's noon is never counted. And the unit case of the gladys-imeon
// 0.1.2 review: a reset read at 23:59.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'UTC';
const { MINUTE, P, replay } = await import('./helpers/app.js');
const { eastHouse } = await import('./helpers/earlyMidnight.js');
const { keptOut, noteNewDay, validRef } = await import('../src/app.js');
const { DailyIndex } = await import('../src/daily.js');

test('a house 7 h east of the container: the day before shown again is not counted', async () => {
  const { world, real } = eastHouse();
  const from = P(0, 10);
  const until = P(3, 20);
  const result = await replay({ days: [], world, from, until });
  const expected = real(from, until);
  assert.ok(result.counted <= expected + 0.02, `counted ${result.counted} > real ${expected}`);
  assert.ok(result.counted >= expected - 0.3, `counted ${result.counted} << real ${expected}`);
});

// Adapted from _scratch/gladys-imeon-0.1.2-review/proposed-test-early-midnight.mjs.
const at = (day, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return Date.UTC(2026, 9, 12 + day, h - 2, m);
};
const r3 = (v) => (v === undefined ? undefined : Math.round(v * 1000) / 1000);

function chain() {
  const daily = new DailyIndex(undefined, { timeZone: 'Europe/Paris' });
  const ref = validRef(null);
  return {
    ref,
    read(today, time) {
      if (keptOut(daily, ref, today, time)) return 'kept out';
      const built = daily.read(today, time);
      noteNewDay(daily, ref, time);
      return r3(built);
    },
  };
}

test('the inverter resets at 23:59 (its clock ahead): the day before is still kept out the next day', () => {
  const c = chain();
  c.read(14.9, at(0, '23:57'));
  c.read(15, at(0, '23:58'));
  assert.equal(c.read(0, at(0, '23:59')), 15, 'its midnight, one minute before ours: a new day');
  assert.equal(
    c.ref.dayBefore.day,
    '2026-10-13',
    'noted for the night it starts, not for 2026-10-12',
  );
  for (let m = 1; m <= 60; m += 1) c.read(r3(m * 0.1), at(0, '23:59') + m * MINUTE);
  c.read(6.1, at(1, '12:00'));
  // A reboot after a silence shows the day before again: never a rise of today's counter.
  assert.equal(c.read(15, at(1, '12:40')), 'kept out');
  assert.equal(c.read(6.3, at(1, '12:41')), 21.3, 'the real counter goes on');
});
