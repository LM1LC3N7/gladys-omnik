// -----------------------------------------------------------------------------
// Review 1: whole days replayed against the real app, what the core would
// count compared with the energy really produced (B1, I1, I2, I3, M1, M2, M6).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keptOut, maxKwOf, noteNewDay, validRef } from '../src/app.js';
import { DailyIndex } from '../src/daily.js';
import { createMemoryStore } from '../src/store.js';
import { SERIAL } from './fixtures/omnik.js';
import {
  CONFIG,
  F,
  HOUR,
  MINUTE,
  P,
  createInverter,
  created,
  printed,
  replay,
  setup,
  solarDay,
  solarWorld,
} from './helpers/app.js';

/** Counted against real: never more (2 Wh of rounding), and at most `less` kWh less. */
function assertClose({ counted, real }, less = 0.25, label = '') {
  assert.ok(counted <= real + 0.02, `${label} counted ${counted} > real ${real}`);
  assert.ok(counted >= real - less, `${label} counted ${counted} << real ${real}`);
}

/** Three days, the second one with its own profiles; `profiles`: [day 0, day 1] kWh. */
const PROFILES = [
  ['grey after sunny', [14.3, 9.7]],
  ['sunny after grey', [4.1, 18]],
  ['equal days', [12, 12.05]],
];
const daysOf = ([k0, k1]) => [solarDay(0, k0), solarDay(1, k1, 8.0), solarDay(2, 10)];
const lastRead = (day) => day.today(day.b - MINUTE);
const final = (day) => day.today(day.b);

/** Sunrise of day 1: 0 -> 0.05 over 20 min, `gap` min silent, then `value` (the day before) 10 min. */
function dawn(days, { gap, value }) {
  const base = solarWorld(days);
  const wake = days[1].a;
  return (t) => {
    if (t > wake && t <= wake + 20 * MINUTE) {
      return { power: 30, energy: printed(Math.min(0.05, ((t - wake) / (20 * MINUTE)) * 0.05)) };
    }
    if (t > wake + 20 * MINUTE && t <= wake + (20 + gap) * MINUTE) return 'timeout';
    if (t > wake + (20 + gap) * MINUTE && t <= wake + (30 + gap) * MINUTE) {
      return { power: 40, energy: printed(value) };
    }
    return base(t);
  };
}

test('control: three solar days counted, never more', async () => {
  for (const [label, kwh] of PROFILES) {
    const days = daysOf(kwh);
    assertClose(
      await replay({ days, world: solarWorld(days), from: P(0, 10), until: P(2, 20) }),
      0.25,
      label,
    );
  }
});

test('B1 Z3: the day before shown again after a silent dawn is never counted', async () => {
  for (const gap of [10, 40, 60]) {
    for (const [label, kwh] of PROFILES) {
      const days = daysOf(kwh);
      const world = dawn(days, { gap, value: final(days[0]) });
      assertClose(
        await replay({ days, world, from: P(0, 10), until: P(2, 20) }),
        0.25,
        `${gap} min ${label}`,
      );
    }
  }
});

test('B1 Z3e: the exact last value of the day before after a silent dawn', async () => {
  for (const [label, kwh] of PROFILES) {
    const days = daysOf(kwh);
    const world = dawn(days, { gap: 40, value: lastRead(days[0]) });
    assertClose(await replay({ days, world, from: P(0, 10), until: P(2, 20) }), 0.25, label);
  }
});

test('B1 Z4: a restart of the inverter at noon showing the day before again', async () => {
  for (const [label, kwh] of PROFILES) {
    const days = daysOf(kwh);
    const base = solarWorld(days);
    const world = (t) => {
      if (t > P(1, 12) && t <= P(1, 12, 35)) return 'timeout';
      if (t > P(1, 12, 35) && t <= P(1, 12, 50))
        return { power: 900, energy: printed(final(days[0])) };
      return base(t);
    };
    assertClose(await replay({ days, world, from: P(0, 10), until: P(2, 20) }), 0.25, label);
  }
});

test('B1 Z6: a restart of the container at night keeps the marks of the day before (/data)', async () => {
  for (const [label, kwh] of PROFILES) {
    const days = daysOf(kwh);
    const world = dawn(days, { gap: 40, value: final(days[0]) });
    const result = await replay({
      days,
      world,
      from: P(0, 10),
      until: P(2, 20),
      // At night, then right after the new day (the marks must come from /data).
      restartAt: [P(1, 2), P(1, 8, 15)],
    });
    assertClose(result, 0.25, label);
    const kept = result.store.data.indexes[F('production_index')];
    assert.ok(kept.ref.dayBefore, 'the value of the day before is in /data');
  }
});

test('I1: at sunrise the day before plus a few Wh (counted after our last read) is kept out', async () => {
  for (const [label, kwh] of PROFILES) {
    const days = daysOf(kwh);
    const base = solarWorld(days);
    const world = (t) =>
      t > days[1].a && t < days[1].a + 20 * MINUTE
        ? { power: 20, energy: printed(lastRead(days[0]) + 0.01) }
        : base(t);
    assertClose(await replay({ days, world, from: P(0, 10), until: P(2, 20) }), 0.25, label);
  }
});

test('the marks: a sunrise band, the day before remembered, a slow pass through it costs nothing', () => {
  const daily = new DailyIndex(null, { maxKw: 5 });
  const ref = validRef(null);
  daily.read(10, P(0, 17), { value: 1000 });
  assert.equal(keptOut(daily, ref, 10.05, P(1, 8)), 'sunrise');
  assert.equal(keptOut(daily, ref, 10.11, P(1, 8)), undefined, 'above the band: a counter');
  assert.equal(ref.staleSeen.value, 10.05);
  daily.read(0.02, P(1, 8, 5), undefined, { elapsedMs: 15 * HOUR });
  noteNewDay(daily, ref, P(1, 8, 5));
  assert.deepEqual(ref.dayBefore, { day: '2026-10-22', value: 10.05 });
  // Later that day, the day before again while today's counter is low: kept out.
  assert.equal(keptOut(daily, ref, 10.06, P(1, 12)), 'again');
  // The real counter passing slowly through that level: a slow rise from the
  // counter taken is never kept out (0.1.4 review, R1); a jump into the band is.
  assert.equal(daily.read(9.9, P(1, 15)) !== undefined, true);
  assert.equal(keptOut(daily, ref, 9.98, P(1, 15, 1)), undefined, 'a slow rise: taken');
  assert.equal(keptOut(daily, ref, 10.05, P(1, 15, 1)), 'again', 'a jump of 0.15: kept out');
  assert.equal(keptOut(daily, ref, 10.16, P(1, 15, 2)), undefined);
  assert.equal(daily.read(10.16, P(1, 15, 2)), daily.state().offset + 10.16);
  assert.equal(keptOut(daily, ref, 10.1, P(1, 15, 3)), undefined, 'today is no longer under it');
  // A mark read back from /data that is odd is dropped.
  assert.deepEqual(
    validRef({ dayBefore: { day: 'x', value: 1 }, staleSeen: { day: '2026-10-22', value: -1 } }),
    {
      dayBefore: null,
      staleSeen: null,
    },
  );
});

test('M2: the counter of the day before kept out is not published as the energy of the day', async () => {
  const days = daysOf([8, 9]);
  const base = solarWorld(days);
  const world = (t) =>
    t > days[1].a && t < days[1].a + 20 * MINUTE
      ? { power: 20, energy: printed(final(days[0])) }
      : base(t);
  const { gladys } = await replay({ days, world, from: P(0, 10), until: P(1, 8, 10) });
  const stale = gladys.fake.states.filter(
    (s) => s.device_feature_external_id === F('energy_today') && s.state === final(days[0]),
  );
  assert.equal(stale.length, 0, 'never the day before in the energy of the day');
});

test('I2: a drop of the built index is never accepted; it corrects itself', async () => {
  const store = createMemoryStore({
    serial: SERIAL,
    indexes: {
      [F('production_index')]: {
        guard: { last: { value: 1000, at: P(0, 11, 59) }, held: null },
        daily: { offset: 980, today: 10, readAt: P(0, 11, 59), readDay: '2026-10-21' },
      },
    },
  });
  const inverter = createInverter(() => ({ power: 500, energy: '10.00' }));
  const { app, gladys, start, wait } = await setup({
    devices: [created({ index: { value: 1000, at: P(0, 11, 59) } })],
    store,
    now: P(0, 12),
    inverter,
  });
  await start();
  const message = gladys.fake.connectionStatus.message;
  assert.match(message.fr, /est revenu de 1000 à 990 kWh/);
  assert.doesNotMatch(message.fr, /Accepter/);
  assert.doesNotMatch(message.en, /Accept/);
  assert.match((await app.acceptHeldIndex()).en, /never accepted/);
  await wait(MINUTE);
  assert.equal(gladys.fake.lastState(F('production_index')), 1000);
  // The counter climbs back above: the index goes on, only the new energy counted.
  inverter.world = () => ({ power: 500, energy: '20.40' });
  for (let i = 0; i < 30; i += 1) {
    inverter.world = () => ({ power: 500, energy: printed(10 + (i + 1) * 0.35) });
    await wait(MINUTE);
  }
  assert.ok(gladys.fake.lastState(F('production_index')) > 1000);
  assert.ok(gladys.fake.lastState(F('production_index')) <= 1000.6);
});

test('I3 Z12: the margin of the installation keeps out a false reading after a silence', async () => {
  const peaks = Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-1${i}`, w: 3000 }));
  assert.equal(maxKwOf(undefined, peaks), 4.5);
  assert.equal(maxKwOf(undefined, peaks.slice(1)), 30, 'not before 7 days of peaks');
  assert.equal(maxKwOf(3, []), 4, '1.25 x the peak power typed');
  assert.equal(maxKwOf(0.5, []), 2, 'bounded at 2 kW');
  assert.equal(maxKwOf(80, []), 30, 'bounded at 30 kW');
  assert.equal(
    maxKwOf(
      undefined,
      peaks.map((p) => ({ ...p, w: 100 })),
    ),
    2,
  );
  const days = [solarDay(0, 14)];
  const base = solarWorld(days);
  const world = (t) => {
    if (t > P(0, 13) && t <= P(0, 13, 30)) return 'timeout';
    if (t > P(0, 13, 30) && t <= P(0, 13, 31))
      return { power: 2000, energy: printed(days[0].today(t) + 12) };
    return base(t);
  };
  const store = createMemoryStore({ serial: SERIAL, peaks });
  // Never more. (Less: after a jump src/daily.js takes nothing more that
  // day, the afternoon is lost; on the side of counting less, as approved.)
  const result = await replay({ days, world, from: P(0, 10), until: P(0, 20), store });
  assert.ok(result.counted <= result.real + 0.02, `learned: ${result.counted} > ${result.real}`);
  assert.equal(result.app.maxKw(), 4.5);
  // The same with the peak power typed (no peaks known yet).
  const typed = await replay({
    days,
    world,
    from: P(0, 10),
    until: P(0, 20),
    config: { ...CONFIG, peak_power_kw: 3.6 },
  });
  assert.ok(typed.counted <= typed.real + 0.02, `typed: ${typed.counted} > ${typed.real}`);
  assert.equal(typed.app.maxKw(), 4.5);
  // Without either: the 30 kW margin of before lets it through (what the peak power fixes).
  const blind = await replay({ days, world, from: P(0, 10), until: P(0, 20) });
  assert.ok(blind.counted > blind.real + 5);
});

test('I3: the peaks are learned from the power and kept in /data', async () => {
  const store = createMemoryStore();
  const inverter = createInverter(() => ({ power: 2345, energy: '5.00' }));
  const { start } = await setup({ devices: [created()], store, now: P(0, 12), inverter });
  await start();
  assert.deepEqual(store.data.peaks, [{ day: '2026-10-21', w: 2345 }]);
});

test('M1: a board answering without inverter right after production is red, asleep after an hour', async () => {
  const inverter = createInverter(() => ({ power: 2000, energy: '8.00' }));
  const { gladys, start, wait } = await setup({ devices: [created()], inverter, now: P(0, 12) });
  await start();
  inverter.world = () => ({ count: 0 });
  await wait(MINUTE);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.fr, /répond sans son onduleur/);
  assert.equal(gladys.fake.lastState(F('power')), 2000, 'no power 0 written');
  await wait(HOUR + 15 * MINUTE);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(gladys.fake.lastState(F('power')), 0);
});

test('M1: another Wi-Fi logger without inverter writes nothing into the device', async () => {
  // The html source: the page carries the logger's id (cover_mid).
  const inverter = createInverter(() => ({ power: 20, energy: '8.00', source: 'html' }));
  const { gladys, start, wait, store } = await setup({
    devices: [created()],
    inverter,
    now: P(0, 18),
    config: { address: '192.168.1.70', source: 'html', username: 'admin', password: 'pw' },
  });
  await start();
  assert.match(store.data.board, /^[0-9a-f]{12}$/);
  assert.ok(
    !JSON.stringify(store.data).includes('602123456'),
    'the logger id itself is never kept',
  );
  const states = gladys.fake.states.length;
  inverter.world = () => ({ count: 0, registry: '602000000', source: 'html' });
  await wait(MINUTE);
  assert.equal(gladys.fake.states.length, states);
  assert.match(gladys.fake.connectionStatus.message.fr, /autre enregistreur Wi-Fi/);
  // Its own logger without inverter: asleep.
  inverter.world = () => ({ count: 0, source: 'html' });
  await wait(2 * MINUTE);
  assert.match(gladys.fake.connectionStatus.message.fr, /en veille/);
});

test('M6: a new address of the same inverter reaches the Discovery list at its first reading', async () => {
  const inverter = createInverter(() => ({ power: 500, energy: '3.00' }));
  const { app, gladys, wait, start } = await setup({
    devices: [created()],
    inverter,
    now: P(0, 12),
  });
  await start();
  await app.start({ address: '192.168.1.61' });
  await wait(MINUTE);
  const [device] = gladys.fake.discoveredDevices;
  assert.equal(device.params.find((p) => p.name === 'address').value, '192.168.1.61');
});

// --- Review 2 -----------------------------------------------------------------

/** The day before shown `below` kWh UNDER the last value read, after a silence. */
function silentThenBelow(days, { from, minutes, below }) {
  const base = solarWorld(days);
  const value = lastRead(days[0]) - below;
  return (t) => {
    if (t > from && t <= from + minutes * MINUTE) return 'timeout';
    if (t > from + minutes * MINUTE && t <= from + (minutes + 15) * MINUTE) {
      return { power: 700, energy: printed(value) };
    }
    return base(t);
  };
}

test('R1: the day before 0.05 kWh under the last read, 3 kWp typed, silent 09:00-12:00', async () => {
  const days = [solarDay(0, 9), solarDay(1, 6), solarDay(2, 8), solarDay(3, 8)];
  const world = silentThenBelow(days, { from: P(1, 9), minutes: 180, below: 0.05 });
  const result = await replay({
    days,
    world,
    from: P(0, 10),
    until: P(3, 20),
    config: { ...CONFIG, peak_power_kw: 3 },
  });
  assert.ok(result.counted <= result.real + 0.02, `${result.counted} > ${result.real}`);
});

test('R1: the day before 0.05 kWh under the last read, first week without kWp, silent 12:00-12:35', async () => {
  const days = [solarDay(0, 14.3), solarDay(1, 9.7), solarDay(2, 8), solarDay(3, 8)];
  const world = silentThenBelow(days, { from: P(1, 12), minutes: 35, below: 0.05 });
  const result = await replay({ days, world, from: P(0, 10), until: P(3, 20) });
  assertClose(result, 0.25);
});

test('R1: a dawn in the undo window showing the day before 0.05 kWh under the last read', async () => {
  for (const [label, kwh] of PROFILES) {
    const days = daysOf(kwh);
    const world = dawn(days, { gap: 10, value: lastRead(days[0]) - 0.05 });
    assertClose(await replay({ days, world, from: P(0, 10), until: P(2, 20) }), 0.25, label);
  }
});

test('m1: an aberrant power never widens the learned margin', async () => {
  const peaks = Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-1${i}`, w: 3000 }));
  const inverter = createInverter(() => ({ power: 65535, energy: '5.00' }));
  const store = createMemoryStore({ serial: SERIAL, peaks });
  const { app, start, wait } = await setup({
    devices: [created()],
    store,
    now: P(0, 12),
    inverter,
  });
  await start();
  assert.equal(app.maxKw(), 4.5, 'seen once: ignored');
  inverter.world = () => ({ power: 2500, energy: '5.05' });
  await wait(MINUTE);
  inverter.world = () => ({ power: 65535, energy: '5.10' });
  await wait(MINUTE);
  assert.equal(app.maxKw(), 4.5, 'not twice in a row');
  // A plausible power seen twice in a row: a real bigger installation, learned
  // (65535 W just before never counts as the first of the two, 0.1.2 n2).
  inverter.world = () => ({ power: 5000, energy: '5.20' });
  await wait(MINUTE);
  assert.equal(app.maxKw(), 4.5);
  inverter.world = () => ({ power: 5200, energy: '5.30' });
  await wait(MINUTE);
  assert.equal(app.maxKw(), 7.5);
  // With the peak power typed, anything above 1.5 x it is never a peak.
  const typed = await setup({
    devices: [created()],
    now: P(0, 12),
    inverter: createInverter(() => ({ power: 9000, energy: '5.00' })),
    config: { ...CONFIG, peak_power_kw: 3 },
  });
  await typed.start();
  assert.deepEqual(typed.store.data.peaks, []);
});

// --- 0.1.2 (review 3, n1 and n2) ---------------------------------------------------

const dullMonth = (n, w) =>
  createMemoryStore({
    serial: SERIAL,
    peaks: Array.from({ length: n }, (_, i) => ({
      day: `2026-10-${String(19 - i).padStart(2, '0')}`,
      w,
    })),
  });

test('n1: an outage that ends in full sun after a dull month no longer loses the day', async () => {
  const days = [solarDay(0, 33), solarDay(1, 33), solarDay(2, 31)];
  const base = solarWorld(days);
  const world = (t) => (t > P(0, 8, 30) && t <= P(0, 11, 30) ? 'timeout' : base(t));
  const result = await replay({
    days,
    world,
    from: P(0, 7),
    until: P(2, 20),
    store: dullMonth(7, 1300),
  });
  assertClose(result, 0.4, 'learned 1.3 kW, no kWp');
  // The power of that read was not recorded as a peak: the peak grew with the
  // following reads only (each within 1.5 x the one before).
  assert.ok(result.app.maxKw() <= 30);
});

test('n1: the widened margin of one read never counts a wrong counter with a sane power', async () => {
  const days = [solarDay(0, 14)];
  const base = solarWorld(days);
  // 30 min silent, then ONE read +12 kWh with the power of the moment (1.3 kW learned).
  const world = (t) => {
    if (t > P(0, 13) && t <= P(0, 13, 30)) return 'timeout';
    if (t > P(0, 13, 30) && t <= P(0, 13, 31)) {
      return { power: days[0].power(t), energy: printed(days[0].today(t) + 12) };
    }
    return base(t);
  };
  const result = await replay({
    days,
    world,
    from: P(0, 10),
    until: P(0, 20),
    store: dullMonth(7, 2500),
  });
  assert.ok(result.counted <= result.real + 0.02, `${result.counted} > ${result.real}`);
});

test('n2: 65535 W is never a peak nor a margin, even twice in a row or in the first week', async () => {
  for (const [label, store] of [
    ['7 days known', dullMonth(7, 4500)],
    ['first week', dullMonth(3, 4500)],
  ]) {
    const inverter = createInverter(() => ({ power: 65535, energy: '5.00' }));
    const { app, start, wait } = await setup({
      devices: [created()],
      store,
      now: P(0, 12),
      inverter,
    });
    await start();
    inverter.world = () => ({ power: 65535, energy: '5.05' });
    await wait(MINUTE);
    assert.ok(!app.peaks.some((p) => p.w > 25_000), label);
    assert.equal(app.readMaxKw(65535), app.maxKw(), label);
  }
  // A Zeversolar inverter of 20 kW is still learned.
  const big = dullMonth(7, 15_000);
  const inverter = createInverter(() => ({ power: 20_000, energy: '5.00' }));
  const { app, start } = await setup({ devices: [created()], store: big, now: P(0, 12), inverter });
  await start();
  assert.equal(app.readMaxKw(20_000), 30);
});

// --- 0.1.4: small days (the gladys-imeon 0.1.2 approval R1) ------------------------

test('a small day before (0.06 kWh): a fresh 0.01 at sunrise is the new day, not kept out', () => {
  const daily = new DailyIndex(null, { maxKw: 5 });
  const ref = validRef(null);
  daily.read(0.06, P(0, 16), { value: 1000 });
  assert.equal(keptOut(daily, ref, 0.01, P(1, 8, 36)), undefined);
  const built = daily.read(0.01, P(1, 8, 36), undefined, { elapsedMs: 16 * HOUR });
  noteNewDay(daily, ref, P(1, 8, 36));
  assert.equal(built, 1000, 'a new day: the index does not move');
  assert.equal(daily.state().readDay, '2026-10-22');
  // The day before itself, or within the band above its half, stays kept out.
  const again = new DailyIndex(null, { maxKw: 5 });
  again.read(0.06, P(0, 16), { value: 1000 });
  assert.equal(keptOut(again, validRef(null), 0.06, P(1, 8, 36)), 'sunrise');
  assert.equal(keptOut(again, validRef(null), 0.04, P(1, 8, 36)), 'sunrise');
});

test('a week of small days (the board answers 6 min after waking up): counted, never more', async () => {
  // 150 W for the first 30 minutes of each day (0.075 kWh), 08:30 to 16:30.
  const rise = (d) => P(d, 8.5);
  const exact = (d, t) => Math.max(0, Math.min(t - rise(d), 30 * MINUTE)) * (0.15 / HOUR);
  const days = Array.from({ length: 7 }, (_, d) => d);
  const world = (t) => {
    const d = days.find((dd) => t >= P(dd, 0) && t < P(dd + 1, 0));
    if (d === undefined || t < rise(d) + 6 * MINUTE || t >= P(d, 16.5)) return 'timeout';
    const power = t - rise(d) < 30 * MINUTE ? 150 : 0;
    return { power, energy: printed(Math.floor(exact(d, t) * 100 + 1e-9) / 100) };
  };
  const from = P(0, 7);
  const until = P(6, 20);
  const result = await replay({ days: [], world, from, until });
  const real = days.reduce((sum, d) => sum + exact(d, until) - exact(d, from), 0);
  assert.ok(result.counted <= real + 0.02, `counted ${result.counted} > real ${real}`);
  // Each day loses at most its first value (the rule of src/daily.js), never the day.
  assert.ok(result.counted >= real - 7 * 0.03, `counted ${result.counted} << real ${real}`);
});

// --- 0.1.4 review: slow rises never kept out ---------------------------------------

test('a week of 0.15 kWh days spread over 8 h: counted, never more, no day lost', async () => {
  const rise = (d) => P(d, 8.5);
  const set = (d) => P(d, 16.5);
  const exact = (d, t) => {
    const x = Math.min(1, Math.max(0, (t - rise(d)) / (set(d) - rise(d))));
    return (0.15 * (1 - Math.cos(Math.PI * x))) / 2;
  };
  const days = Array.from({ length: 7 }, (_, d) => d);
  const world = (t) => {
    const d = days.find((dd) => t >= P(dd, 0) && t < P(dd + 1, 0));
    if (d === undefined || t < rise(d) + 6 * MINUTE || t >= set(d)) return 'timeout';
    return { power: 30, energy: printed(Math.floor(exact(d, t) * 100 + 1e-9) / 100) };
  };
  const from = P(0, 7);
  const until = P(6, 20);
  const result = await replay({ days: [], world, from, until });
  const real = days.reduce((sum, d) => sum + exact(d, until) - exact(d, from), 0);
  assert.ok(result.counted <= real + 0.02, `counted ${result.counted} > real ${real}`);
  // At most the first value of each day (0.01) and the rounding.
  assert.ok(result.counted >= real - 7 * 0.025, `counted ${result.counted} << real ${real}`);
});

test('two 3 kWh days ending 0.05 kWh apart: nothing lost to the band', async () => {
  const days = [solarDay(0, 3), solarDay(1, 3.05)];
  const from = P(0, 7);
  const until = P(1, 20);
  const result = await replay({ days, world: solarWorld(days), from, until });
  assert.ok(
    result.counted <= result.real + 0.02,
    `counted ${result.counted} > real ${result.real}`,
  );
  // Only the first value of the second day and the rounding (was up to 0.1-0.2 kWh).
  assert.ok(
    result.counted >= result.real - 0.04,
    `counted ${result.counted} << real ${result.real}`,
  );
});
