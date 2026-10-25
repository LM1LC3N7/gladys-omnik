// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted inverter and a virtual
// clock, and solar days to replay whole days (review 1 scenarios).
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { OmnikApp } from '../../src/app.js';
import { buildDevice } from '../../src/devices.js';
import { createMemoryStore } from '../../src/store.js';
import { OmnikClient } from '../../src/omnik/client.js';
import { ADDRESS, NOW, SERIAL, page, text } from '../fixtures/omnik.js';
import { createFetch, timeoutError } from './fakeNet.js';
import { createFakeClock } from './fakeTimers.js';

export const SELECTOR = 'omnik';
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const F = (key, serial = SERIAL) => `ext:${SELECTOR}:inverter:${serial}:${key}`;
export const CONFIG = { address: ADDRESS };

/** Local time in Paris (CEST until 2026-10-25): day d (0 = 2026-10-21), hour h, minute m. */
export const P = (d, h, m = 0) =>
  Date.parse('2026-10-20T22:00:00Z') + d * DAY + h * HOUR + m * MINUTE;

/** The device as the user created it, the index Gladys holds when given. */
export function created({ index, serial = SERIAL } = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  const device = buildDevice(
    gladys,
    { serial, model: 'omnik3000tl' },
    { address: ADDRESS, source: 'js' },
  );
  if (index) {
    const feature = device.features.find((f) => f.external_id === F('production_index', serial));
    feature.last_value = index.value;
    feature.last_value_changed = new Date(index.at).toISOString();
  }
  return device;
}

/** The inverter: `world(t)` -> page options | 'timeout'. */
export function createInverter(world = () => ({})) {
  const inverter = { world, clock: { now: NOW } };
  inverter.net = createFetch(() => {
    const answer = inverter.world(inverter.clock.now);
    if (answer === 'timeout') throw timeoutError();
    return text(page(answer));
  });
  return inverter;
}

export async function setup({
  devices = [],
  store = createMemoryStore(),
  now = NOW,
  inverter = createInverter(),
  config = CONFIG,
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices });
  await gladys.connect();
  const { clock, timers, advance } = createFakeClock(now);
  let drift = 0;
  inverter.clock = clock;
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const app = new OmnikApp({
    gladys,
    logger: { lines, info: log, warn: log, error: log, debug: log },
    now: () => clock.now,
    // A real monotonic clock moves between two reads of it: 1 µs per call
    // here, so that a decision reading the clock twice is caught.
    monotonic: () => clock.now + (drift += 0.001),
    timers,
    store,
    clientFactory: (options) => new OmnikClient({ ...options, fetchImpl: inverter.net.fetch }),
  });
  const start = async (cfg = config) => {
    await app.start(cfg);
    await advance(0);
    await app.idle();
  };
  const wait = async (ms) => {
    await advance(ms);
    await app.idle();
  };
  return { app, gladys, clock, store, inverter, start, wait, advance, lines };
}

/** The logger's counter of the day: kWh to 0.01 (the js field is in 0.01 kWh). */
export const printed = (v) => Math.round(v * 100) / 100;

/** A solar day: `kwh` from `rise` to `set` (local hours), the counter floored to 0.01. */
export function solarDay(d, kwh, rise = 7.5, set = 18.5) {
  const a = P(d, 0) + rise * HOUR;
  const b = P(d, 0) + set * HOUR;
  const x = (t) => Math.min(1, Math.max(0, (t - a) / (b - a)));
  const exact = (t) => kwh * ((1 - Math.cos(Math.PI * x(t))) / 2);
  return {
    d,
    a,
    b,
    exact,
    today: (t) => Math.floor(exact(t) * 100 + 1e-9) / 100,
    power: (t) =>
      t <= a || t >= b
        ? 0
        : Math.round((kwh * 1000 * Math.PI * Math.sin(Math.PI * x(t))) / 2 / ((b - a) / HOUR)),
    on: (t) => t > a && t < b,
  };
}

/** The answers of an inverter following `days`, asleep (silent) at night. */
export const solarWorld = (days) => (t) => {
  const day = days.find((dd) => t >= P(dd.d, 0) && t < P(dd.d + 1, 0));
  if (!day || !day.on(t)) return 'timeout';
  return { power: day.power(t), energy: printed(day.today(t)) };
};

/** Energy really produced between t0 and t1. */
export const realBetween = (days, t0, t1) =>
  days.reduce((sum, day) => sum + day.exact(t1) - day.exact(t0), 0);

/**
 * What the core counts from the published index: every rise in full, drops
 * skipped (as its 30-minute production), from `start`.
 */
export function counter(start) {
  const core = { value: start, counted: 0, seen: new Map() };
  core.collect = (gladys) => {
    const states = gladys.fake.states;
    let i = core.seen.get(gladys) ?? 0;
    for (; i < states.length; i += 1) {
      const s = states[i];
      if (s.device_feature_external_id === F('production_index')) {
        if (s.state > core.value) core.counted += s.state - core.value;
        core.value = s.state;
      }
    }
    core.seen.set(gladys, i);
  };
  return core;
}

/**
 * Replays `world` from `from` to `until`; `restartAt`: times the container
 * restarts (a new app on the same /data, Gladys holding the last index).
 * Returns { counted, real, app, store, core }.
 */
export async function replay({
  days,
  world,
  from,
  until,
  restartAt = [],
  store = createMemoryStore(),
  config,
}) {
  const core = counter(1000);
  const inverter = createInverter(world);
  let s = await setup({
    devices: [created({ index: { value: 1000, at: from - MINUTE } })],
    store,
    now: from,
    inverter,
    config,
  });
  await s.start();
  const restarts = [...restartAt];
  while (s.clock.now < until) {
    const step = Math.min(10 * MINUTE, until - s.clock.now);
    await s.wait(step);
    core.collect(s.gladys);
    if (restarts.length > 0 && s.clock.now >= restarts[0]) {
      restarts.shift();
      await s.app.stop();
      const at = s.clock.now;
      s = await setup({
        devices: [created({ index: { value: core.value, at: at - HOUR } })],
        store,
        now: at,
        inverter,
        config,
      });
      await s.start();
      core.collect(s.gladys);
    }
  }
  return {
    counted: Math.round(core.counted * 1000) / 1000,
    real: Math.round(realBetween(days, from, until) * 1000) / 1000,
    app: s.app,
    gladys: s.gladys,
    store,
    core,
  };
}
