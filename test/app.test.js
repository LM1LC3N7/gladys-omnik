// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and a fake Omnik
// Wi-Fi logger, on a virtual clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { OmnikApp } from '../src/app.js';
import {
  ACTIONS,
  LONG_SILENCE,
  PAUSE_MIN,
  POLL_INTERVAL,
  SLEEP_INTERVAL,
} from '../src/constants.js';
import { buildDevice } from '../src/devices.js';
import { createMemoryStore } from '../src/store.js';
import { OmnikClient } from '../src/omnik/client.js';
import { ADDRESS, LOGGER_ID, NOW, SERIAL, page, text } from './fixtures/omnik.js';
import { createFetch, refusedError, timeoutError } from './helpers/fakeNet.js';
import { createFakeClock } from './helpers/fakeTimers.js';

const SELECTOR = 'omnik';
const DEVICE = `ext:${SELECTOR}:inverter:${SERIAL}`;
const F = (key, serial = SERIAL) => `ext:${SELECTOR}:inverter:${serial}:${key}`;
const CONFIG = { address: ADDRESS };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function createLogger() {
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  return { lines, info: log, warn: log, error: log, debug: log };
}

/** The device as the user created it from the discovered one. */
function created({ index, serial = SERIAL } = {}) {
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

/** The inverter: `inverter.answer` is the next answer (a function of the call). */
function createInverter() {
  const inverter = { answer: () => text(page()) };
  inverter.net = createFetch((call) => inverter.answer(call));
  inverter.set = (options) => {
    inverter.answer = () => text(page(options));
  };
  inverter.down = (error = refusedError) => {
    inverter.answer = () => {
      throw error();
    };
  };
  return inverter;
}

async function setup({
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
  const logger = createLogger();
  const app = new OmnikApp({
    gladys,
    logger,
    now: () => clock.now,
    // A real monotonic clock moves between two reads of it: 1 µs per call
    // here, so that a decision reading the clock twice is caught.
    monotonic: () => clock.now + (drift += 0.001),
    timers,
    store,
    clientFactory: (options) => new OmnikClient({ ...options, fetchImpl: inverter.net.fetch }),
  });
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());
  gladys.onAction(ACTIONS.ACCEPT_HELD, () => app.acceptHeldIndex());
  /** Starts with this configuration and waits for the read that follows. */
  const start = async (cfg = config) => {
    await app.start(cfg);
    await advance(0);
    await app.idle();
  };
  /** Moves the clock, running the reads due on the way. */
  const wait = async (ms) => {
    await advance(ms);
    await app.idle();
  };
  return { app, gladys, clock, logger, store, inverter, start, wait, advance };
}

const status = (gladys) => gladys.fake.connectionStatus;
const reads = (inverter) => inverter.net.calls.length;
const discoveries = (gladys) => gladys.fake.bodies('POST', '/discovered_device').length;
const last = (gladys, key, serial) => gladys.fake.lastState(F(key, serial));
const indexStates = (gladys) =>
  gladys.fake.states.filter((s) => s.device_feature_external_id === F('production_index'));

test('an incomplete or wrong configuration: the status says so, nothing is called', async () => {
  for (const [config, pattern] of [
    [{}, /Saisissez l’adresse/],
    [{ address: 'http://u:p@1.2.3.4' }, /pas valide/],
    [{ address: 'x'.repeat(400) }, /pas valide/],
  ]) {
    const { gladys, inverter, start } = await setup({ config });
    await start(config);
    assert.equal(status(gladys).connected, false);
    assert.match(status(gladys).message.fr, pattern);
    assert.equal(reads(inverter), 0);
    assert.match(String((await gladys.fake.action(ACTIONS.TEST)).data.message.fr), pattern);
  }
});

test('the inverter is discovered by its serial; no value before its device is created', async () => {
  const { gladys, store, start, logger } = await setup();
  await start();
  const [device] = gladys.fake.discoveredDevices;
  assert.equal(device.external_id, DEVICE);
  assert.equal(device.name, `Omnik ${SERIAL}`);
  assert.equal(gladys.fake.states.length, 0);
  assert.equal(status(gladys).connected, true);
  assert.match(status(gladys).message.fr, /Découverte/);
  assert.equal(store.data.serial, SERIAL);
  // The id of the logger is nowhere.
  const everything = JSON.stringify([
    logger.lines,
    store.data,
    gladys.fake.connectionStatuses,
    gladys.fake.discoveredDevices,
  ]);
  assert.ok(!everything.includes(LOGGER_ID));
});

test('a created device gets its values and its index; read-only, one GET a minute', async () => {
  const { gladys, inverter, start, wait } = await setup({ devices: [created()] });
  inverter.set({ power: 1500, energy: '5.20' });
  await start();
  assert.equal(last(gladys, 'power'), 1500);
  assert.equal(last(gladys, 'energy_today'), 5.2);
  assert.equal(last(gladys, 'production_index'), 5.2, 'a new device starts from the counter');
  assert.equal(last(gladys, 'awake'), 1);
  assert.equal(last(gladys, 'temperature'), undefined, 'the js source gives no temperature');
  assert.match(status(gladys).message.en, /Connected to the Omnik inverter/);
  inverter.set({ power: 1600, energy: '5.25' });
  await wait(30_000);
  assert.equal(reads(inverter), 1, 'never two reads less than a minute apart');
  await wait(30_000);
  assert.equal(reads(inverter), 2);
  assert.equal(last(gladys, 'production_index'), 5.25);
  assert.ok(inverter.net.calls.every((c) => c.path === '/js/status.js' && c.init.method === 'GET'));
  assert.equal(gladys.fake.publishedEnergyConsumption.length, 0);
});

test('the night: asleep after 3 silent reads, power 0, the index never 0 nor dropped', async () => {
  const device = created({ index: { value: 1000, at: NOW - MINUTE } });
  const { gladys, inverter, start, wait } = await setup({ devices: [device] });
  inverter.set({ power: 20, energy: '12.40' });
  await start();
  assert.equal(last(gladys, 'production_index'), 1000, 'goes on from what Gladys holds');
  inverter.set({ power: 10, energy: '12.50' });
  await wait(MINUTE);
  assert.equal(last(gladys, 'production_index'), 1000.1);
  // Sunset: the Wi-Fi logger goes away.
  inverter.down(timeoutError);
  await wait(MINUTE);
  await wait(MINUTE);
  assert.equal(status(gladys).connected, true, 'not red: the evening');
  assert.equal(last(gladys, 'power'), 10);
  await wait(MINUTE);
  assert.equal(last(gladys, 'power'), 0);
  assert.equal(last(gladys, 'awake'), 0);
  assert.equal(status(gladys).connected, true);
  assert.match(status(gladys).message.fr, /en veille/);
  // Asleep: one try every 5 minutes.
  const before = reads(inverter);
  await wait(SLEEP_INTERVAL - 1);
  assert.equal(reads(inverter), before);
  await wait(1);
  assert.equal(reads(inverter), before + 1);
  // The whole night.
  const indexes = indexStates(gladys).length;
  await wait(18 * HOUR);
  assert.equal(indexStates(gladys).length, indexes, 'no index at night');
  // Sunrise (the next day): the counter starts again from 0.
  inverter.set({ power: 15, energy: '0.0' });
  await wait(SLEEP_INTERVAL);
  assert.equal(last(gladys, 'awake'), 1);
  assert.equal(last(gladys, 'energy_today'), 0);
  assert.equal(last(gladys, 'production_index'), 1000.1, 'never 0, never a drop');
  inverter.set({ power: 300, energy: '0.05' });
  await wait(MINUTE);
  assert.equal(last(gladys, 'production_index'), 1000.15);
  assert.ok(indexStates(gladys).every((s) => s.state > 0));
  assert.equal(gladys.fake.publishedEnergyConsumption.length, 0);
});

test('sunrise with the counter of the day before: no index until the new day starts', async () => {
  const device = created({ index: { value: 500, at: NOW - MINUTE } });
  const { gladys, inverter, start, wait, app } = await setup({ devices: [device] });
  inverter.set({ power: 20, energy: '8.00' });
  await start();
  assert.equal(last(gladys, 'production_index'), 500);
  inverter.set({ count: 0 });
  await wait(MINUTE);
  assert.equal(last(gladys, 'awake'), 0);
  assert.match(status(gladys).message.fr, /enregistreur Wi-Fi répond/);
  await wait(18 * HOUR);
  // The next morning, still yesterday's counter.
  inverter.set({ power: 20, energy: '8.00' });
  await wait(SLEEP_INTERVAL);
  assert.equal(app.stale, true);
  assert.match(status(gladys).message.fr, /compteur de la veille/);
  // Its new day: 0.1, then 1.0 kWh: counted from the new day only. A rise of
  // 0.9 kWh in a minute stays under the margin (30 kW and 0.5 kWh of slack:
  // 1 kWh), whatever microseconds the test clock drifts.
  inverter.set({ power: 50, energy: '0.10' });
  await wait(MINUTE);
  assert.equal(last(gladys, 'production_index'), 500);
  inverter.set({ power: 900, energy: '1.00' });
  await wait(10 * MINUTE);
  assert.equal(last(gladys, 'production_index'), 500.9);
});

test('an inverter that vanishes while producing: red at once, then asleep after an hour', async () => {
  const { gladys, inverter, start, wait } = await setup({ devices: [created()] });
  inverter.set({ power: 2500, energy: '10.0' });
  await start();
  inverter.down();
  await wait(MINUTE);
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.fr, /injoignable.*1 min/);
  const before = reads(inverter);
  await wait(MINUTE);
  assert.equal(reads(inverter), before + 1);
  assert.match(status(gladys).message.fr, /2 min/);
  await wait(HOUR);
  assert.equal(status(gladys).connected, true);
  assert.match(status(gladys).message.fr, /en veille/);
  assert.equal(last(gladys, 'power'), 0);
});

test('no answer for more than a day: red, even at night', async () => {
  const { gladys, inverter, start, wait } = await setup();
  inverter.down();
  await start();
  await wait(5 * MINUTE);
  assert.match(status(gladys).message.fr, /en veille/);
  await wait(LONG_SILENCE);
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.fr, /aucune lecture depuis plus d’un jour/);
});

test('a Wi-Fi logger that answers without inverter for a day: red too', async () => {
  const inverter = createInverter();
  inverter.set({ count: 0 });
  const { gladys, start, wait } = await setup({ inverter });
  await start();
  assert.equal(status(gladys).connected, true);
  assert.match(status(gladys).message.fr, /enregistreur Wi-Fi répond/);
  await wait(LONG_SILENCE + SLEEP_INTERVAL);
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.fr, /aucune lecture/);
  inverter.set({ power: 30 });
  await wait(SLEEP_INTERVAL);
  assert.equal(status(gladys).connected, true);
});

test('429 and 5xx: a bounded pause kept in /data, never a read before its end', async () => {
  const store = createMemoryStore();
  const inverter = createInverter();
  inverter.answer = () => text('busy', { status: 429, headers: { 'retry-after': '1' } });
  const { gladys, start, wait, clock } = await setup({ store, inverter });
  await start();
  assert.match(status(gladys).message.fr, /demande d’attendre/);
  assert.equal(store.data.pause.until, clock.now + PAUSE_MIN, 'never shorter than a poll');
  const before = reads(inverter);
  await wait(30_000);
  assert.equal(reads(inverter), before);
  // A restart keeps the pause; a pause from /data far in the future is capped.
  const far = createMemoryStore({
    pause: { until: clock.now + 1000 * HOUR, count: 3, code: 'server', status: 503 },
  });
  const other = createInverter();
  const again = await setup({ store: far, now: clock.now, inverter: other });
  await again.start();
  assert.equal(reads(other), 0);
  assert.match(status(again.gladys).message.fr, /6 h/);
  assert.equal(
    (await again.gladys.fake.action(ACTIONS.TEST)).data.message.fr.includes('6 h'),
    true,
  );
  assert.equal(reads(other), 0, 'the test button never forces a read during a pause');
  // A 503 doubles the pause; back to normal, it ends.
  inverter.answer = () => text('err', { status: 503 });
  await wait(30_000);
  assert.equal(store.data.pause.count, 2);
  assert.equal(store.data.pause.code, 'server');
  inverter.set({});
  await wait(2 * PAUSE_MIN);
  assert.equal(status(gladys).connected, true);
  assert.equal(store.data.pause, null);
});

test('the pace: a reconnection, a save, a scan, the buttons, a creation never read sooner', async () => {
  const store = createMemoryStore();
  const { app, gladys, inverter, start, wait, clock } = await setup({ store });
  await start();
  assert.equal(reads(inverter), 1);
  await wait(10_000);
  await start(); // a reconnection to Gladys
  await start({ ...CONFIG }); // the same configuration saved
  await app.scan();
  const tested = await gladys.fake.action(ACTIONS.TEST);
  assert.match(tested.data.message.fr, /Dernière lecture il y a 10 s/);
  assert.match(tested.data.message.fr, /Prochaine lecture dans 50 s/);
  await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
  await app.onDeviceCreated(gladys.fake.discoveredDevices[0]);
  await app.idle();
  assert.equal(reads(inverter), 1);
  assert.equal(status(gladys).connected, true);
  assert.ok(discoveries(gladys) >= 3, 'Discovery sent again each time');
  await wait(50_000);
  assert.equal(reads(inverter), 2);
  // A restart of the container: the time of the last read is in /data.
  // The test clock drifts by microseconds per read of the monotonic clock.
  assert.ok(Math.abs(store.data.lastAttemptAt - clock.now) < 1, 'the attempt is saved');
  const other = createInverter();
  const again = await setup({ store, now: clock.now + 20_000, inverter: other });
  await again.start();
  assert.equal(reads(other), 0);
  await again.wait(39_999);
  assert.equal(reads(other), 0);
  await again.wait(1);
  assert.equal(reads(other), 1);
  // A date of /data in the future (a clock set back) waits one interval from now.
  const future = createMemoryStore({ lastAttemptAt: NOW + 10 * HOUR });
  const third = await setup({ store: future, inverter: createInverter() });
  await third.start();
  assert.equal(reads(third.inverter), 0);
  await third.wait(POLL_INTERVAL);
  assert.equal(reads(third.inverter), 1);
});

test('the test button reads when a read is due, and says what it read', async () => {
  const inverter = createInverter();
  inverter.set({ power: 777 });
  const { gladys, start, wait } = await setup({ inverter });
  await start();
  await wait(POLL_INTERVAL);
  assert.equal(reads(inverter), 2);
  // Not due: the last read, no request.
  const recent = await gladys.fake.action(ACTIONS.TEST);
  assert.match(
    recent.data.message.en,
    new RegExp(`Read now: Omnik inverter ${SERIAL} \\(omnik3000tl\\), 777 W`),
  );
  assert.equal(reads(inverter), 2);
  inverter.down();
  await wait(POLL_INTERVAL);
  const down = await gladys.fake.action(ACTIONS.TEST);
  assert.match(down.data.message.fr, /injoignable|Dernière lecture/);
});

test('a late answer of the old address publishes nothing and sets no status', async () => {
  const inverter = createInverter();
  inverter.set({ power: 4321, energy: '3.0' });
  const { app, gladys, wait, advance } = await setup({ inverter, devices: [created()] });
  inverter.net.hold = true;
  await app.start(CONFIG);
  const running = advance(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads(inverter), 1);
  // The user enters another address while the first answer is on its way.
  inverter.net.hold = false;
  await app.start({ address: '192.168.1.61' });
  const statuses = gladys.fake.connectionStatuses.length;
  inverter.net.release();
  await running;
  await app.idle();
  assert.equal(last(gladys, 'power'), undefined, 'not one value of the old answer');
  assert.equal(gladys.fake.connectionStatuses.length, statuses, 'no status from the old answer');
  // The new address reads at its time (never sooner than a minute).
  inverter.set({ power: 100, energy: '3.1' });
  await wait(POLL_INTERVAL);
  assert.equal(reads(inverter), 2);
  assert.equal(inverter.net.calls[1].host, '192.168.1.61');
  assert.equal(last(gladys, 'power'), 100);
});

test('the test button makes the read when one is due', async () => {
  const inverter = createInverter();
  inverter.set({ power: 640 });
  const { app } = await setup({ inverter });
  await app.start(CONFIG);
  // The timer of the first read has not fired yet: the click makes it.
  const answer = await app.testConnection();
  assert.match(answer.en, /Read now: Omnik inverter .*640 W\. Next read in 1 min/);
  assert.equal(reads(inverter), 1);
  assert.match((await app.testConnection()).en, /Next read in 1 min/);
  assert.equal(reads(inverter), 1);
});

test('another inverter at the address: its values go to its own device, never the old one', async () => {
  const inverter = createInverter();
  const { gladys, start, wait } = await setup({ inverter, devices: [created()] });
  inverter.set({ power: 1000, energy: '2.0' });
  await start();
  assert.equal(last(gladys, 'power'), 1000);
  inverter.set({ serial: 'ZS15004513777777', power: 30, energy: '9.0' });
  await wait(POLL_INTERVAL);
  assert.equal(last(gladys, 'power'), 1000, 'the old device keeps its value');
  assert.equal(last(gladys, 'power', 'ZS15004513777777'), undefined);
  assert.ok(gladys.fake.discoveredDevices.some((d) => d.external_id.endsWith('ZS15004513777777')));
  assert.match(status(gladys).message.fr, /Découverte/);
  // An answer without inverter (the night) is not another inverter.
  inverter.set({ count: 0 });
  await wait(POLL_INTERVAL);
  assert.match(status(gladys).message.fr, /veille/);
});

test('an index jump is held by the guard, shown, and taken only by the accept button', async () => {
  const store = createMemoryStore({
    serial: SERIAL,
    indexes: {
      [F('production_index')]: {
        guard: null,
        daily: { offset: 1495, today: 5, readAt: NOW - MINUTE, readDay: '2026-10-21' },
      },
    },
  });
  const device = created({ index: { value: 1000, at: NOW - MINUTE } });
  const inverter = createInverter();
  inverter.set({ power: 100, energy: '5.00' });
  const { gladys, start, wait } = await setup({ devices: [device], store, inverter });
  await start();
  assert.equal(last(gladys, 'production_index'), 1000, 'the last accepted value, never the jump');
  assert.match(status(gladys).message.fr, /a sauté de 1000 à 1500 kWh/);
  assert.equal(store.data.indexes[F('production_index')].guard.held.to, 1500);
  // A save of the form accepts nothing.
  await start({ ...CONFIG });
  assert.match(status(gladys).message.fr, /a sauté/);
  const answer = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  assert.match(answer.data.message.en, /500 kWh/);
  await wait(POLL_INTERVAL);
  assert.equal(last(gladys, 'production_index'), 1500);
  assert.doesNotMatch(status(gladys).message.fr, /retenu/);
  const nothing = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  assert.match(nothing.data.message.en, /nothing to accept/);
});

test('a wrong answer: red, retries doubled, never "another device"', async () => {
  const inverter = createInverter();
  inverter.answer = () => text('<html>router</html>');
  const { gladys, start, wait } = await setup({ inverter, devices: [created()] });
  await start();
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.fr, /l’état d’un onduleur Omnik/);
  await wait(MINUTE);
  assert.equal(reads(inverter), 2);
  await wait(MINUTE);
  assert.equal(reads(inverter), 2, 'doubled: 2 min');
  await wait(MINUTE);
  assert.equal(reads(inverter), 3);
  assert.equal(gladys.fake.states.length, 0);
});

test('every connection publishes the status and the device again', async () => {
  const { app, gladys, start } = await setup({ devices: [created()] });
  await start();
  const statuses = gladys.fake.connectionStatuses.length;
  const discovered = discoveries(gladys);
  await app.start(CONFIG);
  await app.idle();
  assert.ok(gladys.fake.connectionStatuses.length > statuses);
  assert.ok(discoveries(gladys) > discovered);
  assert.equal(status(gladys).connected, true);
});

// --- Omnik: sources, credentials, identity ----------------------------------------

const PASSWORD = 'Hunter2-secret';
const HTML = { address: ADDRESS, source: 'html', username: 'admin', password: PASSWORD };

test('a source missing its settings: the status says what to fill, nothing is called', async () => {
  for (const [config, pattern] of [
    [{ address: ADDRESS, source: 'html' }, /nom d’utilisateur et le mot de passe/],
    [{ address: ADDRESS, source: 'tcp' }, /numéro de série de l’enregistreur/],
    [{ address: ADDRESS, source: 'tcp', logger_serial: '12ab' }, /numéro de série/],
  ]) {
    const { gladys, inverter, start } = await setup({ config });
    await start(config);
    assert.equal(status(gladys).connected, false);
    assert.match(status(gladys).message.fr, pattern);
    assert.equal(reads(inverter), 0);
  }
});

test('credentials refused: final and kept, never an automatic try, lifted by a success only', async () => {
  const store = createMemoryStore();
  const inverter = createInverter();
  inverter.answer = () => text('no', { status: 401 });
  const { app, gladys, start, wait, logger, clock } = await setup({
    store,
    inverter,
    config: HTML,
  });
  await start();
  assert.equal(reads(inverter), 1);
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.fr, /refuse le nom d’utilisateur ou le mot de passe/);
  assert.match(store.data.refused.fp, /^[0-9a-f]{32}$/);
  // Never an automatic new try, nor on a save of the same form, nor on a reconnection.
  await wait(6 * HOUR);
  await start();
  await start({ ...HTML });
  await wait(HOUR);
  assert.equal(reads(inverter), 1);
  // A restart of the container keeps the refusal.
  const again = await setup({ store, inverter, config: HTML, now: clock.now });
  await again.start();
  await again.wait(2 * HOUR);
  assert.equal(reads(inverter), 1);
  assert.match(status(again.gladys).message.fr, /refuse/);
  // The test button tries once (at the pace), the refusal stays on a new 401.
  const tried = await again.gladys.fake.action(ACTIONS.TEST);
  assert.equal(reads(inverter), 2);
  assert.match(tried.data.message.fr, /refuse le nom d’utilisateur/);
  const soon = await again.gladys.fake.action(ACTIONS.TEST);
  assert.equal(reads(inverter), 2, 'never more than one read a minute');
  assert.match(soon.data.message.fr, /pourra réessayer dans 1 min/);
  // The logger accepts them again: only the button finds it out, then the reads go on.
  inverter.answer = () => text(page({ source: 'html' }));
  await again.wait(POLL_INTERVAL);
  assert.equal(reads(inverter), 2);
  await again.gladys.fake.action(ACTIONS.TEST);
  assert.equal(reads(inverter), 3);
  assert.equal(store.data.refused, null, 'erased at the first success');
  assert.equal(status(again.gladys).connected, true);
  await again.wait(POLL_INTERVAL);
  assert.equal(reads(inverter), 4);
  // The password is nowhere but in the Authorization header.
  const everything = JSON.stringify([
    logger.lines,
    again.store.data,
    gladys.fake.connectionStatuses,
    again.gladys.fake.connectionStatuses,
    again.gladys.fake.discoveredDevices,
  ]);
  assert.ok(!everything.includes(PASSWORD));
  assert.ok(!everything.includes(Buffer.from(`admin:${PASSWORD}`).toString('base64')));
  assert.ok(!everything.includes(LOGGER_ID), 'the logger id: a fingerprint only');
  assert.equal(
    inverter.net.calls[0].init.headers.authorization,
    `Basic ${Buffer.from(`admin:${PASSWORD}`).toString('base64')}`,
  );
  app.stop();
});

test('credentials refused, then other ones typed: the reads go on at their pace', async () => {
  const inverter = createInverter();
  inverter.answer = () => text('no', { status: 403 });
  const { gladys, start, wait, store } = await setup({ inverter, config: HTML });
  await start();
  assert.match(status(gladys).message.fr, /refuse/);
  inverter.answer = () => text(page({ source: 'html' }));
  await start({ ...HTML, password: 'another-one' });
  assert.equal(reads(inverter), 1, 'never sooner than the pace');
  await wait(POLL_INTERVAL);
  assert.equal(reads(inverter), 2);
  assert.equal(status(gladys).connected, true);
  assert.equal(store.data.refused, null);
});

test('identity: a json answer without serial gets a stable fallback id', async () => {
  const inverter = createInverter();
  inverter.answer = () =>
    text(
      JSON.stringify({
        i_sn: '',
        i_modle: 'omnik2000tl2',
        i_pow_n: 900,
        i_eday: '3.1',
        i_eall: '8000.0',
      }),
    );
  const { gladys, start, store } = await setup({
    inverter,
    config: { address: ADDRESS, source: 'json' },
  });
  await start();
  const [device] = gladys.fake.discoveredDevices;
  assert.match(device.external_id, /^ext:omnik:inverter:host-[0-9a-f]{12}$/);
  assert.ok(!device.external_id.includes(ADDRESS));
  assert.equal(store.data.serial, device.external_id.split(':').at(-1));
  assert.equal(inverter.net.calls[0].path, '/status.json');
});

test('identity (M2): a serial missing now and then is ignored, never red nor a longer wait', async () => {
  const inverter = createInverter();
  const { gladys, start, wait } = await setup({ inverter, devices: [created()] });
  inverter.set({ power: 1000, energy: 2 });
  await start();
  const discovered = gladys.fake.discoveredDevices.length;
  inverter.set({ serial: '<bad>', power: 30, energy: 9 });
  await wait(POLL_INTERVAL);
  assert.equal(status(gladys).connected, true, 'not red');
  assert.match(status(gladys).message.fr, /pas de numéro de série : ignorée/);
  assert.equal(last(gladys, 'power'), 1000, 'nothing written');
  assert.ok(gladys.fake.discoveredDevices.slice(discovered).every((d) => d.external_id === DEVICE));
  const before = reads(inverter);
  await wait(POLL_INTERVAL);
  assert.equal(reads(inverter), before + 1, 'the wait is not doubled');
  inverter.set({ power: 1100, energy: 2.1 });
  await wait(POLL_INTERVAL);
  assert.equal(last(gladys, 'power'), 1100);
  assert.doesNotMatch(status(gladys).message.fr, /ignorée/);
  // Missing for an hour: red.
  inverter.set({ serial: '<bad>', power: 30, energy: 9 });
  await wait(HOUR + POLL_INTERVAL);
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.fr, /pas de numéro de série lisible/);
  assert.equal(last(gladys, 'power'), 1100);
});

/** A json answer of the library's shape. */
const jsonAnswer = ({ sn = '', model = 'omnik2000tl2', rated = '2000', power = 900, today }) =>
  text(
    JSON.stringify({
      i_sn: sn,
      i_modle: model,
      i_pow: rated,
      i_pow_n: power,
      i_eday: String(today),
      i_eall: '8000.0',
    }),
  );

test('identity (I1): a fallback id whose device is created stays when a serial appears', async () => {
  for (const config of [
    { address: ADDRESS, source: 'json' },
    { address: ADDRESS, source: 'html', username: 'admin', password: 'pw' },
  ]) {
    const store = createMemoryStore();
    const inverter = createInverter();
    const answer = (sn, today) =>
      config.source === 'json'
        ? jsonAnswer({ sn, today })
        : text(page({ source: 'html', serial: sn, energy: today }));
    inverter.answer = () => answer('', 3.1);
    const first = await setup({ inverter, store, config });
    await first.start();
    const [found] = first.gladys.fake.discoveredDevices;
    const id = found.external_id.split(':').at(-1);
    assert.match(id, config.source === 'json' ? /^host-/ : /^logger-/);
    await first.app.stop();
    // The user created it; a firmware now gives the serial.
    const device = buildDevice(
      createFakeGladys({ selector: SELECTOR }),
      { serial: id },
      { address: ADDRESS, source: config.source },
    );
    const index = device.features.find((f) => f.external_id.endsWith(':production_index'));
    index.last_value = 1000;
    index.last_value_changed = new Date(NOW - MINUTE).toISOString();
    inverter.answer = () => answer(SERIAL, 3.2);
    const again = await setup({ inverter, store, config, devices: [device], now: NOW + HOUR });
    await again.start();
    inverter.answer = () => answer(SERIAL, 3.5);
    await again.wait(POLL_INTERVAL);
    assert.equal(again.gladys.fake.lastState(F('production_index', id)), 1000.3);
    assert.ok(again.gladys.fake.discoveredDevices.every((d) => d.external_id.endsWith(id)));
    assert.equal(again.gladys.fake.lastState(F('power', SERIAL)), undefined);
    assert.equal(store.data.serial, id, '/data keeps the fallback');
  }
});

/** The `host-` id of ADDRESS (a fingerprint of the address). */
const HOST = `host-${createHash('sha256').update(`omnik-host:${ADDRESS}`).digest('hex').slice(0, 12)}`;
const JSON_CONFIG = { address: ADDRESS, source: 'json' };

test('identity (M1, R2): a host- id refuses another rated power, a renamed model is fine', async () => {
  const store = createMemoryStore();
  const inverter = createInverter();
  inverter.answer = () => jsonAnswer({ today: 3.1 });
  const { gladys, start, wait, app } = await setup({
    inverter,
    store,
    config: JSON_CONFIG,
    devices: [created({ serial: HOST, index: { value: 1000, at: NOW - MINUTE } })],
  });
  await start();
  assert.equal(store.data.signature, '2000');
  // A firmware renames the model, same rated power: never red (R2, S3).
  inverter.answer = () => jsonAnswer({ model: 'Omnik2000TL2', today: 3.2 });
  await wait(POLL_INTERVAL);
  assert.equal(status(gladys).connected, true);
  assert.equal(last(gladys, 'production_index', HOST), 1000.1);
  // Another rated power: red, nothing written.
  inverter.answer = () => jsonAnswer({ model: 'omnik4000tl2', rated: '4000', today: 9 });
  await wait(POLL_INTERVAL);
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.fr, /autre puissance nominale/);
  assert.equal(last(gladys, 'production_index', HOST), 1000.1);
  // The gesture to relearn it (replaced on purpose): the test button.
  const answer = await app.testConnection();
  assert.match(answer.fr, /réapprise à la prochaine lecture/);
  await wait(2 * POLL_INTERVAL);
  assert.equal(status(gladys).connected, true);
  assert.equal(store.data.signature, '4000');
});

test('identity (R2): a rated power at 0 is "not given", first read or each morning', async () => {
  // S2: the very first read gives 0; S1: 0 for a while each morning.
  const inverter = createInverter();
  let rated = '0';
  let today = 3.1;
  inverter.answer = () => jsonAnswer({ rated, today });
  const { gladys, start, wait, store } = await setup({
    inverter,
    config: JSON_CONFIG,
    devices: [created({ serial: HOST, index: { value: 1000, at: NOW - MINUTE } })],
  });
  await start();
  assert.equal(store.data.signature, null, 'nothing learned from a 0');
  rated = '2000';
  today = 3.2;
  await wait(POLL_INTERVAL);
  assert.equal(store.data.signature, '2000');
  rated = '0';
  today = 3.3;
  await wait(POLL_INTERVAL);
  assert.equal(status(gladys).connected, true);
  assert.equal(last(gladys, 'production_index', HOST), 1000.2);
});

test('identity (R1): after a serial is learned, another serial at the address is its own device', async () => {
  const store = createMemoryStore();
  const inverter = createInverter();
  inverter.answer = () => jsonAnswer({ today: 3.1 });
  const { gladys, start, wait } = await setup({
    inverter,
    store,
    config: JSON_CONFIG,
    devices: [created({ serial: HOST, index: { value: 1000, at: NOW - MINUTE } })],
  });
  await start();
  // A firmware gives the serial: learned with the created device, values kept there.
  inverter.answer = () => jsonAnswer({ sn: SERIAL, today: 3.2 });
  await wait(POLL_INTERVAL);
  assert.deepEqual(store.data.learned, { [HOST]: SERIAL });
  assert.equal(last(gladys, 'production_index', HOST), 1000.1);
  // A DHCP swap: another inverter (same rated power) with its own serial.
  inverter.answer = () => jsonAnswer({ sn: 'NLDN9999999999', power: 50, today: 9 });
  await wait(POLL_INTERVAL);
  assert.equal(last(gladys, 'production_index', HOST), 1000.1, 'never written into A');
  assert.equal(last(gladys, 'power', HOST), 900);
  assert.ok(gladys.fake.discoveredDevices.some((d) => d.external_id.endsWith('NLDN9999999999')));
  // A back, with its serial or without: its device again.
  inverter.answer = () => jsonAnswer({ sn: SERIAL, today: 3.3 });
  await wait(POLL_INTERVAL);
  assert.equal(last(gladys, 'production_index', HOST), 1000.2);
  inverter.answer = () => jsonAnswer({ today: 3.4 });
  await wait(POLL_INTERVAL);
  assert.equal(last(gladys, 'production_index', HOST), 1000.3);
});

test('the night (I3): a serial with empty values, or 4294967295, is asleep', async () => {
  const day = {
    js: () => text(page({ power: 20, energy: 5 })),
    json: () => jsonAnswer({ sn: SERIAL, power: 20, today: 5 }),
  };
  for (const [source, night] of [
    ['js', () => text('var webData="NLDN2020123456,V5,V4,omnik3000tl,3000,,,153637,,1,";')],
    [
      'js',
      () => text('var webData="NLDN2020123456,V5,V4,omnik3000tl,3000,4294967295,4294967295,,,1,";'),
    ],
    ['json', () => jsonAnswer({ sn: SERIAL, power: '', today: '' })],
    ['json', () => jsonAnswer({ sn: SERIAL, power: 4294967295, today: '4294967295' })],
  ]) {
    const inverter = createInverter();
    inverter.answer = day[source];
    const { gladys, start, wait } = await setup({
      inverter,
      devices: [created({ index: { value: 1000, at: NOW - MINUTE } })],
      config: { address: ADDRESS, source },
    });
    await start();
    assert.equal(last(gladys, 'power'), 20);
    inverter.answer = night;
    await wait(MINUTE);
    assert.equal(last(gladys, 'power'), 0);
    assert.equal(last(gladys, 'awake'), 0);
    assert.equal(status(gladys).connected, true);
    assert.match(status(gladys).message.fr, /en veille/);
    // The night pace: one read every 5 minutes.
    const before = reads(inverter);
    await wait(SLEEP_INTERVAL - 1);
    assert.equal(reads(inverter), before);
    await wait(1);
    assert.equal(reads(inverter), before + 1);
    assert.equal(last(gladys, 'production_index'), 1000, 'the index never 0 nor dropped');
  }
});
