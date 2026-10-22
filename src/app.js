// -----------------------------------------------------------------------------
// The integration itself: the Wi-Fi logger of the inverter read once a minute
// (every 5 minutes asleep), its device, the production index built from the
// counter of the day and checked by its guard, the night, the pauses and the
// refused credentials kept in /data, the test and accept buttons. index.js
// only wires the SDK handlers to it. Read-only: nothing is ever sent to the
// inverter but the request of its status (one GET, or one tcp request).
//
// Taken from gladys-zeversolar 0.1.4 (approved, the same night and the same
// index), only the reading of the logger and the refused credentials added.
//
// The pace is global and kept across restarts: never two reads less than an
// interval apart, whatever asks (a reconnection, a save of the form, the test
// button, the Discover tab, a device created, a restart of the container: the
// time of the last read is kept in /data).
//
// A read belongs to its session (the client of one address): when the
// address changes, a late answer of the old one publishes nothing and sets no
// status (checked after every await).
//
// The created devices are read from `gladys.devices`, which the SDK keeps up
// to date: never a copy of our own.
//
// Two clocks: `now` (wall clock) dates the index and what /data keeps;
// `monotonic` paces the reads, so that a wall clock set back never stops them.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { credentialsFingerprint, isComplete, missingOf, normalizeConfig } from './config.js';
import {
  ATTEMPT_SAVE_EVERY,
  AWAKE_POWER,
  DAY_ENERGY_MAX,
  DAY_RESET_MAX_KWH,
  DAY_RESET_UNDO_WITHIN,
  DAY_WINDOW_AFTER,
  DAY_WINDOW_BEFORE,
  INDEX_MAX_KW,
  INDEX_SLACK_KWH,
  LONG_SILENCE,
  MAX_KW_MAX,
  MAX_KW_MIN,
  MISSES_BEFORE_ASLEEP,
  PAUSE_MAX,
  PAUSE_MIN,
  PEAK_DAYS_KEPT,
  PEAK_DAYS_MIN,
  PEAK_OUTLIER,
  PLAUSIBLE_POWER_MAX,
  POLL_INTERVAL,
  POWER_MAX,
  RETRY_MAX,
  RETRY_MIN,
  SLEEP_INTERVAL,
  STALE_BAND_KWH,
  STALE_BELOW_KWH,
  STATE_HEARTBEAT,
  TEST_ANSWER_WITHIN,
  TIME_ZONE,
} from './constants.js';
import { DailyIndex, localParts } from './daily.js';
import {
  FEATURE,
  asleepStates,
  buildDevice,
  ids,
  readingStates,
  round,
  within,
} from './devices.js';
import { IndexGuard } from './guard.js';
import { T } from './i18n.js';
import { OmnikClient, OmnikError } from './omnik/client.js';
import { createFileStore } from './store.js';

const defaultTimers = { setTimeout, clearTimeout };

/** The limits of the guard and of the daily index: the SAME `maxKw`, the installation's (I3). */
const guardLimits = (maxKw) => ({ maxKw, slackKwh: INDEX_SLACK_KWH });
const dailyLimits = (maxKw) => ({
  resetMaxKwh: DAY_RESET_MAX_KWH,
  undoWithinMs: DAY_RESET_UNDO_WITHIN,
  maxKw,
  slackKwh: INDEX_SLACK_KWH,
  windowBefore: DAY_WINDOW_BEFORE,
  windowAfter: DAY_WINDOW_AFTER,
  gapMs: 3 * POLL_INTERVAL,
  timeZone: TIME_ZONE,
});

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const clampKw = (kw) => Math.min(MAX_KW_MAX, Math.max(MAX_KW_MIN, Math.ceil(kw * 2) / 2));

/** The daily power peaks kept in /data: `[{ day, w }]`, valid, the last PEAK_DAYS_KEPT days. */
export function validPeaks(peaks) {
  if (!Array.isArray(peaks)) {
    return [];
  }
  return peaks
    .filter(
      (p) =>
        p &&
        typeof p.day === 'string' &&
        DAY.test(p.day) &&
        finite(p.w) &&
        p.w >= 0 &&
        p.w <= POWER_MAX,
    )
    .map((p) => ({ day: p.day, w: p.w }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .slice(-PEAK_DAYS_KEPT);
}

/** The peaks with the power `w` read on local `day`. */
export function withPeak(peaks, day, w) {
  const known = peaks.find((p) => p.day === day);
  if (known) {
    return known.w >= w ? peaks : peaks.map((p) => (p.day === day ? { day, w } : p));
  }
  return validPeaks([...peaks, { day, w }]);
}

/**
 * The margin of the index (kW), the same for the daily index and the guard:
 * 1.25 x the peak power typed, else 1.5 x the highest power of the last 30
 * days once 7 days are known, else INDEX_MAX_KW; bounded 2 to 30 kW.
 */
export function maxKwOf(peakKw, peaks) {
  if (finite(peakKw)) {
    return clampKw(1.25 * peakKw);
  }
  if (peaks.length < PEAK_DAYS_MIN) {
    return INDEX_MAX_KW;
  }
  return clampKw((1.5 * Math.max(...peaks.map((p) => p.w))) / 1000);
}

/** `{ day, value }` read back from /data, else null. */
const validMark = (mark) =>
  mark &&
  typeof mark.day === 'string' &&
  DAY.test(mark.day) &&
  finite(mark.value) &&
  mark.value >= 0
    ? { day: mark.day, value: mark.value }
    : null;

/**
 * The marks of the counter of the day before (review 1, B1 and I1), kept in
 * /data with the index: `dayBefore` the value of the day before for the local
 * day of the new day (the last value taken, or a higher stale value seen at
 * sunrise), `staleSeen` the highest stale value kept out at sunrise that day.
 */
export const validRef = (ref) => ({
  dayBefore: validMark(ref?.dayBefore),
  staleSeen: validMark(ref?.staleSeen),
});

/**
 * Whether the counter `today`, read at `now`, is the day before shown again,
 * to keep out of the index (as a counter not read: its time is not moved):
 * - at sunrise (a later local day than the last value taken), a value within
 *   [last - 0.1 kWh, last + 0.1 kWh] (the inverter may count a little after our
 *   last read): it is noted in `ref.staleSeen`;
 * - later the same local day as a new day, a value back within
 *   [day before - 0.1 kWh, day before + 0.1 kWh] while today's counter taken is
 *   still under the day before - 0.1 kWh, and only as a jump of more than
 *   0.1 kWh from it (a reboot that shows it again; a slow rise is taken).
 * Pure but for `ref.staleSeen`. Returns 'sunrise', 'again' or undefined.
 */
export function keptOut(daily, ref, today, now) {
  const s = daily.state();
  if (!s || !(today > 0)) {
    return undefined;
  }
  const day = daily.local(now).date;
  if (
    s.readDay &&
    day > s.readDay &&
    // Not when the new day of this night is already taken (an inverter whose
    // midnight comes before ours reset at 23:xx): the counter is today's (as
    // gladys-imeon 46c6085).
    s.resetWindow !== daily.window(now).key &&
    // A small day before (0.1.4): a fresh counter under half of it is the
    // new day, never "the day before" (as gladys-imeon).
    today >= Math.max(s.today - STALE_BELOW_KWH, s.today / 2) &&
    today <= s.today + STALE_BAND_KWH
  ) {
    const seen = ref.staleSeen?.day === day ? ref.staleSeen.value : 0;
    ref.staleSeen = { day, value: Math.max(seen, today) };
    return 'sunrise';
  }
  const before = ref.dayBefore;
  if (
    before &&
    // The mark is dated by the night it starts (noteNewDay): a reset read
    // before our midnight (the inverter's clock ahead) is the next day's.
    (before.day === day || before.day === daily.window(now).key) &&
    s.today < before.value - STALE_BAND_KWH &&
    // Only a jump from the counter taken (a reboot after a silence shows the
    // day before at once), never a slow rise of today's counter through the
    // band (0.1.4 review, R1: small days and similar days were lost).
    today - s.today > STALE_BAND_KWH &&
    today >= before.value - STALE_BELOW_KWH &&
    today <= before.value + STALE_BAND_KWH
  ) {
    return 'again';
  }
  return undefined;
}

/** After a read the daily index took: a new day just started notes the value of the day before. */
export function noteNewDay(daily, ref, now) {
  const s = daily.state();
  if (!s?.undo || s.undo.at !== now) {
    return;
  }
  // The date of the night after its midnight (0.1.3): a reset read from 23:00
  // to 23:59 (an inverter whose midnight comes before ours) dates the day it
  // starts, not the one that ends, as in gladys-imeon.
  const day = daily.window(now).key;
  const seen = ref.staleSeen?.day === day ? ref.staleSeen.value : 0;
  ref.dayBefore = { day, value: Math.max(s.undo.prevToday, seen) };
}

/** Silent for this long, even while producing: asleep (night or outage, the status says both). */
const ASLEEP_AFTER = 60 * 60_000;
/** At most this many index states kept in /data (one per inverter serial seen). */
const MAX_KEPT_INDEXES = 8;

const SERIAL = /^[A-Za-z0-9_-]{4,40}$/;
/** The ids given when the answer has no serial (see `identityOf`). */
const FALLBACK_ID = /^(logger|host)-[0-9a-f]{12}$/;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** The fingerprint of an address, for the `host-` fallback id: a short hash, never the address. */
const addressId = (address) =>
  `host-${createHash('sha256').update(`omnik-host:${address}`).digest('hex').slice(0, 12)}`;

/**
 * The id of the inverter of a reading (forever, it fixes the external ids):
 * 1. its serial number, as the answer gives it (js, html, tcp; json on most
 *    loggers);
 * 2. else, when the device known so far has a real serial, none: a serial
 *    unreadable once is never "another inverter" (the reading is refused);
 * 3. else `logger-<fingerprint>` of the logger's id when the answer has one
 *    (html `cover_mid`, the logger serial of a tcp reply);
 * 4. else `host-<fingerprint>` of the address typed (a json answer without
 *    `i_sn`): a new address is then a new device.
 * 0. Before all (review 1, I1): a fallback id whose device the user created
 *    (`keepFallback`) stays the id while the logger (`logger-`) or the
 *    address (`host-`) is the same, even once a serial appears: never a
 *    second device for the same inverter.
 */
export function identityOf(reading, known, address, keepFallback = false) {
  if (keepFallback && known && FALLBACK_ID.test(known)) {
    const same = known.startsWith('logger-')
      ? Boolean(reading.board) && known === `logger-${reading.board}`
      : known === addressId(address);
    if (same) return known;
  }
  if (reading.serial) {
    return reading.serial;
  }
  if (known && !FALLBACK_ID.test(known)) {
    return undefined;
  }
  return reading.board ? `logger-${reading.board}` : addressId(address);
}

const SIGNATURE = /^[A-Za-z0-9._()+:-]{1,48}\|\d{1,9}$/;

/**
 * What tells one inverter from another without a serial (the json source
 * without `i_sn`, review 1 M1): its model and rated power, when both are given.
 */
export function signatureOf(reading) {
  return reading.model && Number.isInteger(reading.rated)
    ? `${reading.model}|${reading.rated}`
    : undefined;
}

/** A refusal of the credentials read back from /data: `{ fp }` (a salted fingerprint), else undefined. */
const validRefused = (refused) =>
  refused && typeof refused.fp === 'string' && /^[0-9a-f]{32}$/.test(refused.fp)
    ? { fp: refused.fp }
    : undefined;

/** The index Gladys already holds for a feature of a created device, when it says so. */
function lastValueOf(device, featureId) {
  const feature = (device?.features ?? []).find((f) => f.external_id === featureId);
  const value = Number(feature?.last_value);
  const at = Date.parse(feature?.last_value_changed ?? '');
  return feature?.last_value !== null &&
    feature?.last_value !== undefined &&
    Number.isFinite(value) &&
    Number.isFinite(at)
    ? { value, at }
    : undefined;
}

/** A pause read back from /data: `{ until, count, code, status }`, its end capped from now. */
function validPause(pause, now) {
  if (
    !pause ||
    !finite(pause.until) ||
    !Number.isInteger(pause.count) ||
    pause.count < 1 ||
    (pause.code !== 'rate_limited' && pause.code !== 'server')
  ) {
    return undefined;
  }
  return {
    until: Math.min(pause.until, now + PAUSE_MAX),
    count: Math.min(pause.count, 32),
    code: pause.code,
    status: Number.isInteger(pause.status) ? pause.status : null,
  };
}

/** The index states kept in /data: plain objects under string keys only. */
function keptIndexes(indexes) {
  if (!indexes || typeof indexes !== 'object' || Array.isArray(indexes)) {
    return {};
  }
  const kept = {};
  for (const [key, value] of Object.entries(indexes)) {
    if (key !== '__proto__' && value && typeof value === 'object' && !Array.isArray(value)) {
      kept[key] = value;
    }
  }
  return kept;
}

export class OmnikApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'omnik' }),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    clientFactory = (options) => new OmnikClient(options),
    store = createFileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.clientFactory = clientFactory;
    /** /data: index, guard, serial, pause, time of the last read and of the last answer. */
    this.store = store;
    this.savedKey = undefined;
    this.config = normalizeConfig();
    /** `{ client }` of the current address; replaced (never reused) when the address changes. */
    this.session = undefined;
    this.running = false;
    this.timer = undefined;
    this.busy = undefined;
    this.loopRun = Promise.resolve();
    this.lifecycle = Promise.resolve();
    this.lastStatus = undefined;

    const kept = store.load();
    const at = now();
    this.pause = validPause(kept.pause, at);
    /**
     * The credentials refused by the logger (401/403): `{ fp }`, a salted
     * fingerprint of the refused set only (never of a set that worked),
     * erased at the first success. While the form gives the same set, no
     * read is ever made but by the test button (lot 12: no automatic retry).
     */
    this.refused = validRefused(kept.refused);
    /** The salt of that fingerprint (random, kept in /data). */
    this.salt =
      typeof kept.salt === 'string' && /^[0-9a-f]{32}$/.test(kept.salt)
        ? kept.salt
        : randomBytes(16).toString('hex');
    this.credentialsFp = undefined;
    /**
     * `{ serial, model, firmware, board }` of the inverter (`board`: the
     * fingerprint of its Wi-Fi logger); the serial and board alone when read back.
     */
    this.info =
      typeof kept.serial === 'string' && SERIAL.test(kept.serial)
        ? {
            serial: kept.serial,
            ...(typeof kept.board === 'string' && /^[0-9a-f]{12}$/.test(kept.board)
              ? { board: kept.board }
              : {}),
            ...(typeof kept.signature === 'string' && SIGNATURE.test(kept.signature)
              ? { signature: kept.signature }
              : {}),
          }
        : undefined;
    /** The daily power peaks, for the margin of the index (I3). */
    this.peaks = validPeaks(kept.peaks);
    /** By index feature external id: the marks of the day before (B1, I1). */
    this.refs = new Map();
    // The last read before a restart: the next one never comes sooner than
    // the interval (a date in the future, a clock set back, is brought to now).
    this.lastAttemptAt = finite(kept.lastAttemptAt) ? Math.min(kept.lastAttemptAt, at) : undefined;
    this.savedAttemptAt = this.lastAttemptAt;
    /** Monotonic time of the last read started. */
    this.lastReadAt =
      this.lastAttemptAt === undefined ? undefined : monotonic() - (at - this.lastAttemptAt);
    /** Wall time of the last reading of the inverter itself (with its values), for LONG_SILENCE. */
    this.lastGoodAt = finite(kept.lastGoodAt) ? Math.min(kept.lastGoodAt, at) : undefined;
    this.startedAt = at;
    this.resetReads();

    /** By index feature external id: IndexGuard, DailyIndex, monotonic time of the last counter read. */
    this.guards = new Map();
    this.dailies = new Map();
    this.counterReadAt = new Map();
  }

  /** What belongs to one address: forgotten when it changes. */
  resetReads() {
    /** The last read: `{ at (monotonic), kind: 'reading' | 'asleep' | 'error', reading?, err? }`. */
    this.outcome = undefined;
    this.asleep = false;
    /** Asleep because the Wi-Fi board answered without inverter (else: no answer at all). */
    this.asleepBoard = false;
    this.misses = 0;
    this.firstMissAt = undefined;
    /** The power of the last reading (W): an inverter that vanishes producing more is not asleep. */
    this.lastPower = undefined;
    /** Wrong answers and vanished inverters: retries doubled, in memory. */
    this.failures = 0;
    this.nextTryAt = undefined;
    this.lastError = undefined;
    /** Monotonic time of the first of the answers without serial in a row (M2). */
    this.serialMissingSince = undefined;
    this.noIndex = false;
    this.stale = false;
    this.otherInverter = undefined;
  }

  /** The credentials of the form are the ones the logger refused: no automatic read. */
  refusedNow() {
    return Boolean(this.refused && this.refused.fp === this.credentialsFp);
  }

  // --- Lifecycle -------------------------------------------------------------

  start(raw = {}) {
    return this.serialize(() => this.doStart(raw));
  }

  stop() {
    return this.serialize(() => this.doStop());
  }

  /** Resolves once every queued start/stop and the read running are done (tests). */
  async idle() {
    await this.lifecycle;
    await this.loopRun;
    await this.busy;
  }

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  async doStart(raw) {
    this.doStop();
    const config = normalizeConfig(raw);
    const first = this.session === undefined;
    // What the logger is asked with: another one is another session (the
    // password only in memory, as the form gives it).
    const target = (c) =>
      JSON.stringify([
        c.address,
        c.invalidAddress,
        c.source,
        c.username,
        c.password,
        c.loggerSerial ?? null,
      ]);
    const changed = first || target(config) !== target(this.config);
    this.config = config;
    this.credentialsFp = credentialsFingerprint(config, this.salt);
    if (changed) {
      this.session = {
        client: isComplete(config)
          ? this.clientFactory({
              address: config.address,
              source: config.source,
              username: config.username,
              password: config.password,
              loggerSerial: config.loggerSerial,
            })
          : undefined,
      };
      if (!first) {
        // Another address or source: its own story. A pause asked by the old
        // one ends; the pace does not (never two reads less than an interval
        // apart); a refusal is kept, lifted only by other credentials (it
        // no longer matches) or a success.
        this.resetReads();
        this.lastGoodAt = undefined;
        this.startedAt = this.now();
        if (this.pause) {
          this.pause = undefined;
          await this.saveState();
        }
      }
    }
    this.running = true;
    // The core keeps the connection status, the Discovery list and the last
    // values in memory: a restarted Gladys has lost them, so they are always
    // sent again (the values at the next read).
    this.lastStatus = undefined;
    this.gladys.forgetPublishedStates?.();
    if (!this.session.client) {
      await this.setStatus(...this.currentStatus());
      return;
    }
    if (!changed || first) {
      // Another address may be another inverter: its device is published
      // once its serial is read, never the old one with the new address.
      await this.discover();
    }
    await this.updateStatus();
    this.schedule();
  }

  doStop() {
    this.running = false;
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  // --- Pace ------------------------------------------------------------------

  /** The monotonic time from which the next read may start. */
  dueAt() {
    const mono = this.monotonic();
    let due =
      this.lastReadAt === undefined
        ? mono
        : this.lastReadAt + (this.asleep ? SLEEP_INTERVAL : POLL_INTERVAL);
    if (this.nextTryAt !== undefined) {
      due = Math.max(due, this.nextTryAt);
    }
    const now = this.now();
    if (this.pause && now < this.pause.until) {
      due = Math.max(due, mono + (this.pause.until - now));
    }
    return due;
  }

  /** One timer: the next read when it is due. */
  schedule() {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.running || !this.session?.client || this.refusedNow()) {
      // Refused credentials: never an automatic read (only the test button).
      return;
    }
    const wait = Math.max(0, this.dueAt() - this.monotonic());
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.loopRun = this.loop();
      return this.loopRun;
    }, wait);
  }

  async loop() {
    const session = this.session;
    try {
      await this.tick();
    } catch (err) {
      this.logger.error(`Omnik: unexpected error (${err?.name ?? 'Error'})`);
    }
    if (session === this.session && this.running) {
      this.schedule();
    }
  }

  /**
   * One read when it is due; a read running is never doubled. `manual`: the
   * test button, the only one that reads with refused credentials.
   */
  tick({ manual = false } = {}) {
    if (this.busy) {
      return this.busy;
    }
    this.busy = this.read(manual).finally(() => {
      this.busy = undefined;
    });
    return this.busy;
  }

  async read(manual = false) {
    const session = this.session;
    const client = session?.client;
    if (!client || !this.running || (this.refusedNow() && !manual)) {
      return;
    }
    const mono = this.monotonic();
    if (mono < this.dueAt()) {
      return;
    }
    /** Another address (or a stop) during an await: this read gives up, silently. */
    const gone = () => session !== this.session || !this.running;
    this.lastReadAt = mono;
    // Kept BEFORE the request: a restart during it never reads again sooner.
    await this.saveAttempt(this.now());
    if (gone()) return;
    let reading;
    try {
      reading = await client.readStatus();
    } catch (err) {
      if (gone()) return;
      await this.failed(err, mono, gone);
      return;
    }
    if (gone()) return;
    await this.succeeded(reading, mono, gone);
  }

  async saveAttempt(now) {
    this.lastAttemptAt = now;
    if (
      this.savedAttemptAt === undefined ||
      now < this.savedAttemptAt ||
      now - this.savedAttemptAt >= ATTEMPT_SAVE_EVERY
    ) {
      this.savedAttemptAt = now;
      await this.saveState();
    }
  }

  // --- Outcomes ----------------------------------------------------------------

  async succeeded(reading, mono, gone) {
    // An answer: a pause asked before is over, and credentials refused before
    // (the test button) are no longer (lot 12: lifted only by a success).
    this.pause = undefined;
    if (this.refused) {
      this.refused = undefined;
      this.logger.info('Omnik: the logger accepts the credentials again');
    }
    if (reading.kind === 'asleep') {
      if (this.info?.board && reading.board && reading.board !== this.info.board) {
        // Another Wi-Fi logger at this address (a DHCP swap): its empty page
        // says nothing of our inverter, never written into its device (M1).
        await this.failed(new OmnikError('other_board'), mono, gone);
        return;
      }
      const producing =
        !this.asleep && this.lastPower !== undefined && this.lastPower >= AWAKE_POWER;
      this.firstMissAt ??= mono;
      if (producing && mono - this.firstMissAt < ASLEEP_AFTER) {
        // The board answers without its inverter right after it produced:
        // not the night, red (as an inverter that vanishes producing), M1.
        await this.failed(new OmnikError('no_inverter'), mono, gone);
        return;
      }
    }
    // The identity of this read: the serial in the same answer as its values.
    const serial =
      reading.kind === 'reading'
        ? identityOf(reading, this.info?.serial, this.config.address, Boolean(this.createdDevice()))
        : undefined;
    if (reading.kind === 'reading' && serial === undefined) {
      // A serial unreadable once is never "another inverter": nothing written.
      // A logger that omits it now and then (review 1, M2): the read is
      // ignored, without red nor a longer wait; only an hour of it is red.
      this.serialMissingSince ??= mono;
      if (mono - this.serialMissingSince < ASLEEP_AFTER) {
        this.logger.warn('Omnik: an answer without serial number, ignored');
        await this.updateStatus();
        return;
      }
      await this.failed(new OmnikError('no_serial'), mono, gone);
      return;
    }
    this.serialMissingSince = undefined;
    // The json source without serial (`host-` id): the model and rated power
    // told by the answer must stay the same (review 1, M1); another inverter
    // behind the address (a DHCP swap) is red and writes nothing.
    const signature = reading.kind === 'reading' ? signatureOf(reading) : undefined;
    if (
      serial?.startsWith('host-') &&
      signature &&
      this.info?.serial === serial &&
      this.info.signature &&
      this.info.signature !== signature
    ) {
      await this.failed(new OmnikError('other_model'), mono, gone);
      return;
    }
    this.failures = 0;
    this.nextTryAt = undefined;
    this.lastError = undefined;
    this.misses = 0;
    this.firstMissAt = undefined;
    if (reading.kind === 'asleep') {
      // The Wi-Fi board answers, the inverter gives nothing: the night.
      this.asleep = true;
      this.asleepBoard = true;
      this.lastPower = 0;
      this.outcome = { at: mono, kind: 'asleep' };
      await this.publishAsleep(gone);
      if (gone()) return;
      await this.saveState();
      if (gone()) return;
      await this.updateStatus();
      return;
    }
    this.asleep = false;
    this.asleepBoard = false;
    this.lastGoodAt = this.now();
    const power = within(reading.power, POWER_MAX);
    if (power !== undefined) {
      this.lastPower = power;
    }
    const kept = this.info?.serial === serial ? this.info.signature : undefined;
    const info = {
      serial,
      model: reading.model,
      firmware: reading.firmware,
      ...(reading.board ? { board: reading.board } : {}),
      ...(serial.startsWith('host-') && (signature ?? kept)
        ? { signature: signature ?? kept }
        : {}),
    };
    const previous = this.info?.serial;
    if (previous !== undefined && previous !== info.serial) {
      this.otherInverter = info.serial;
      this.logger.warn('Omnik: another inverter answers at this address');
    }
    const infoChanged = JSON.stringify(info) !== JSON.stringify(this.info);
    this.info = info;
    this.outcome = { at: mono, kind: 'reading', reading };
    const peak = this.plausiblePeak(power);
    if (peak !== undefined) {
      this.peaks = withPeak(this.peaks, localParts(this.now(), TIME_ZONE).date, peak);
    }
    const session = this.session;
    if (infoChanged || !session.discovered) {
      // Also the first reading of a session: a new address of the same
      // inverter reaches the Discovery list at once (M6).
      session.discovered = true;
      await this.discover();
      if (gone()) return;
    }
    await this.publishReading(reading, gone);
    if (gone()) return;
    await this.saveState();
    if (gone()) return;
    await this.updateStatus();
  }

  async failed(err, mono, gone) {
    const code = err?.code ?? 'error';
    const now = this.now();
    // Our own words only (OmnikError codes): never a text of the logger.
    this.logger.warn(
      `Omnik read failed: ${code}${Number.isInteger(err?.status) ? ` ${err.status}` : ''}`,
    );
    this.outcome = { at: mono, kind: 'error', err };
    if (code === 'auth') {
      // The user name or password refused (401/403): final and kept in /data
      // (lot 12), never an automatic new try with the same set; only other
      // credentials in the form or a success of the test button lift it.
      this.refused = { fp: this.credentialsFp };
      this.lastError = err;
      this.failures = 0;
      this.nextTryAt = undefined;
      await this.saveState();
      if (gone()) return;
      await this.updateStatus();
      return;
    }
    if (code === 'rate_limited' || code === 'server') {
      const count = (this.pause?.count ?? 0) + 1;
      const asked = finite(err.retryAfter) ? err.retryAfter : PAUSE_MIN * 2 ** (count - 1);
      const wait = Math.min(Math.max(asked, PAUSE_MIN), PAUSE_MAX);
      this.pause = {
        until: now + wait,
        count: Math.min(count, 32),
        code,
        status: Number.isInteger(err.status) ? err.status : null,
      };
      await this.saveState();
      if (gone()) return;
      await this.updateStatus();
      return;
    }
    if (code === 'timeout' || code === 'unreachable') {
      this.misses += 1;
      this.firstMissAt ??= mono;
      if (this.asleep) {
        // Still the night (or the board went to sleep too): no change but the status.
        this.asleepBoard = false;
        await this.updateStatus();
        return;
      }
      const low = this.lastPower === undefined || this.lastPower < AWAKE_POWER;
      if ((low && this.misses >= MISSES_BEFORE_ASLEEP) || mono - this.firstMissAt >= ASLEEP_AFTER) {
        this.asleep = true;
        this.asleepBoard = false;
        this.failures = 0;
        this.nextTryAt = undefined;
        this.lastError = undefined;
        this.logger.info('Omnik inverter asleep (no answer)');
        await this.publishAsleep(gone);
        if (gone()) return;
        await this.updateStatus();
        return;
      }
      if (low) {
        // Falling asleep, probably (the evening): nothing red yet.
        return;
      }
    }
    // A wrong answer, or an inverter that vanished while producing: red,
    // retries doubled (never faster than a poll).
    const wait = Math.min(RETRY_MIN * 2 ** this.failures, RETRY_MAX);
    this.failures += 1;
    this.lastError = err;
    this.nextTryAt = mono + wait;
    await this.updateStatus();
  }

  // --- Status ------------------------------------------------------------------

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  async updateStatus() {
    const [connected, message] = this.currentStatus();
    await this.setStatus(connected, message);
  }

  /** The status from what is known now: never a read. */
  currentStatus() {
    const address = this.config.address;
    if (!this.session?.client) {
      return [
        false,
        this.config.invalidAddress ? T.badAddress : T.incomplete(missingOf(this.config)),
      ];
    }
    const notes = this.heldNotes();
    const now = this.now();
    if (this.refusedNow()) {
      return [false, T.refused(address, notes)];
    }
    if (this.pause && now < this.pause.until) {
      return [false, T.paused(address, this.pause, this.pause.until - now, notes)];
    }
    if (this.lastError && this.failures > 0) {
      const wait = Math.max(0, (this.nextTryAt ?? 0) - this.monotonic());
      return [false, T.unreachable(address, this.lastError, wait, notes)];
    }
    if (this.asleep) {
      const since = this.lastGoodAt ?? this.startedAt;
      if (now - since > LONG_SILENCE) {
        return [false, T.silent(address, notes)];
      }
      return [true, T.asleep(address, this.asleepBoard, notes)];
    }
    if (this.outcome?.kind === 'reading' && this.info) {
      if (!this.createdDevice()) {
        return [true, T.noDevice(this.info.serial)];
      }
      const extra = [];
      if (this.otherInverter) extra.push(T.notes.otherInverter(this.otherInverter));
      if (this.serialMissingSince !== undefined) extra.push(T.notes.noSerial);
      if (this.stale) extra.push(T.notes.stale);
      if (this.noIndex) extra.push(T.notes.noIndex);
      return [true, T.ok(address, [...extra, ...notes])];
    }
    return [false, T.waitingSerial(address)];
  }

  /** The index held back, for every status (the user must see it while waiting). */
  heldNotes() {
    const created = this.createdDevice();
    if (!created) {
      return [];
    }
    const held = this.guardOf(created, this.external().feature(FEATURE.PRODUCTION_INDEX)).held;
    return held ? [T.notes.held(held)] : [];
  }

  // --- /data -------------------------------------------------------------------------

  /** Keeps the serial, the pause, the times and the index in /data when they changed. */
  async saveState() {
    const indexes = {};
    for (const [id, guard] of this.guards) {
      indexes[id] = {
        guard: guard.state(),
        daily: this.dailies.get(id)?.state() ?? null,
        ref: this.refs.get(id) ?? null,
      };
    }
    const kept = keptIndexes(this.store.load().indexes);
    for (const id of Object.keys(indexes)) delete kept[id];
    const merged = Object.entries({ ...kept, ...indexes }).slice(-MAX_KEPT_INDEXES);
    const state = {
      serial: this.info?.serial ?? null,
      board: this.info?.board ?? null,
      signature: this.info?.signature ?? null,
      peaks: this.peaks,
      pause: this.pause ?? null,
      // Only a refused set's salted fingerprint, never a working one's.
      refused: this.refused ?? null,
      salt: this.salt,
      lastAttemptAt: this.lastAttemptAt ?? null,
      lastGoodAt: this.lastGoodAt ?? null,
      indexes: Object.fromEntries(merged),
    };
    const key = JSON.stringify(state);
    if (key === this.savedKey) {
      return;
    }
    try {
      await this.store.save(state);
      this.savedKey = key;
    } catch (err) {
      this.logger.warn(`Saving the Omnik state in /data failed (${err?.code ?? 'error'})`);
    }
  }

  // --- Devices -----------------------------------------------------------------------

  external() {
    return this.info ? ids(this.gladys, this.info.serial) : undefined;
  }

  /** The created Gladys device of the inverter, undefined until the user creates it. */
  createdDevice() {
    const id = this.external()?.device;
    return id ? (this.gladys.devices ?? []).find((d) => d.external_id === id) : undefined;
  }

  async discover() {
    if (!this.info || !this.session?.client) {
      return;
    }
    await this.gladys
      .publishDiscoveredDevices([
        buildDevice(this.gladys, this.info, {
          address: this.config.address,
          source: this.config.source,
        }),
      ])
      .catch((err) => this.logger.warn(`Publishing the Omnik device failed: ${err.message}`));
  }

  /** The Discover tab asks: the known device, never a read (the next one comes at its time). */
  async scan() {
    await this.discover();
  }

  async onDeviceCreated(device) {
    const external = this.external();
    if (!external || device?.external_id !== external.device) {
      return;
    }
    // A new device: no reference of its index yet (nor a state kept in /data
    // for a deleted device of the same id). Its values come at the next read.
    const id = external.feature(FEATURE.PRODUCTION_INDEX);
    this.guards.delete(id);
    this.dailies.delete(id);
    this.refs.delete(id);
    this.counterReadAt.delete(id);
    const kept = this.store.load();
    const indexes = keptIndexes(kept.indexes);
    delete indexes[id];
    await this.store
      .save({ ...kept, indexes })
      .catch((err) =>
        this.logger.warn(`Clearing the Omnik index state failed (${err?.code ?? 'error'})`),
      );
    this.savedKey = undefined;
    // The inverter now answering has its device: the note about it ends.
    this.otherInverter = undefined;
    await this.updateStatus();
  }

  async onDeviceUpdated(device) {
    if (device?.external_id === this.external()?.device) {
      await this.updateStatus();
    }
  }

  // --- Values ------------------------------------------------------------------------

  /**
   * The power of a reading as a peak to learn, or undefined (review 2, m1):
   * above 1.5 x the typed peak power, never; above 1.5 x the highest of the
   * last 30 days (once 7 are known), only when seen twice in a row (then the
   * lower of the two). A value of error (65535 W) never widens the margin.
   */
  plausiblePeak(power) {
    const previous = this.outlierPower;
    this.outlierPower = undefined;
    if (power === undefined || power > PLAUSIBLE_POWER_MAX) {
      // Aberrant (65535 W, above any Omnik model): never a peak, even
      // seen twice or in the first week (0.1.2, n2).
      return undefined;
    }
    if (finite(this.config.peakKw)) {
      return power > PEAK_OUTLIER * this.config.peakKw * 1000 ? undefined : power;
    }
    if (this.peaks.length < PEAK_DAYS_MIN) {
      return power;
    }
    const top = PEAK_OUTLIER * Math.max(...this.peaks.map((p) => p.w));
    if (power <= top) {
      return power;
    }
    if (previous !== undefined) {
      return Math.min(previous, power);
    }
    this.outlierPower = power;
    return undefined;
  }

  /**
   * The margin of one read (kW): the installation's, widened to 1.5 x the
   * power of that read when it is above it, plausible and no peak power is
   * typed (0.1.2, n1). Counting too much then needs a wrong counter AND a
   * wrong power in the same answer.
   */
  readMaxKw(power) {
    const kw = this.maxKw();
    if (finite(this.config.peakKw) || !finite(power) || power < 0 || power > PLAUSIBLE_POWER_MAX) {
      return kw;
    }
    return Math.max(kw, clampKw((PEAK_OUTLIER * power) / 1000));
  }

  /** The margin of the index now (kW): typed peak power, else learned (I3). */
  maxKw() {
    return maxKwOf(this.config.peakKw, this.peaks);
  }

  /**
   * The guard of the index of the created device, from Gladys and /data,
   * with the daily index and the marks of the day before. When the margin
   * of the installation changed, both are built again from their own state
   * with the new one (the same for both).
   */
  guardOf(created, id) {
    const kw = this.maxKw();
    if (!this.guards.has(id)) {
      const saved = keptIndexes(this.store.load().indexes)[id];
      this.guards.set(
        id,
        new IndexGuard(lastValueOf(created, id), saved?.guard, this.now(), guardLimits(kw)),
      );
      this.dailies.set(id, new DailyIndex(saved?.daily, dailyLimits(kw), this.now()));
      this.refs.set(id, validRef(saved?.ref));
    } else if (this.guards.get(id).maxKw !== kw) {
      const now = this.now();
      this.guards.set(
        id,
        new IndexGuard(undefined, this.guards.get(id).state(), now, guardLimits(kw)),
      );
      this.dailies.set(id, new DailyIndex(this.dailies.get(id).state(), dailyLimits(kw), now));
    }
    return this.guards.get(id);
  }

  /** The states of a reading, the index through the daily counter and the guard. */
  async publishReading(reading, gone) {
    this.noIndex = false;
    this.stale = false;
    const created = this.createdDevice();
    if (!created) {
      return;
    }
    const external = this.external();
    const id = external.feature(FEATURE.PRODUCTION_INDEX);
    const guard = this.guardOf(created, id);
    const daily = this.dailies.get(id);
    const ref = this.refs.get(id);
    const now = this.now();
    const today = within(reading.energyToday, DAY_ENERGY_MAX);
    let index;
    const stale = today === undefined ? undefined : keptOut(daily, ref, today, now);
    if (stale) {
      // The day before shown again (B1, I1): not a counter read (its time is
      // not moved), nothing counted, the counter of the day not sent either.
      this.stale = true;
    } else if (today !== undefined) {
      // The time since the previous counter read, on the monotonic clock: a
      // wall clock jumping forward never forges a cut across midnight
      // (src/daily.js). Unknown after a restart.
      const mono = this.monotonic();
      const previous = this.counterReadAt.get(id);
      this.counterReadAt.set(id, mono);
      // The margin of THIS read only (0.1.2, n1): a plausible power above the
      // learned peak (the first read after an outage that ends in full sun)
      // widens it for this read, never recorded as a peak. Restored at once
      // (no await in between): the shared classes keep their own code.
      const kw = this.maxKw();
      const readKw = this.readMaxKw(reading.power);
      daily.limits.maxKw = readKw;
      guard.maxKw = readKw;
      let built;
      let plausible;
      try {
        built = daily.read(today, now, guard.last ?? lastValueOf(created, id), {
          elapsedMs: previous === undefined ? undefined : mono - previous,
        });
        noteNewDay(daily, ref, now);
        const total = built === undefined ? undefined : round(built, 3);
        built = total;
        plausible = total !== undefined && guard.accept(total, now);
      } finally {
        daily.limits.maxKw = kw;
        guard.maxKw = kw;
      }
      const total = built;
      this.noIndex = total === undefined;
      if (total !== undefined && !plausible && guard.held) {
        this.logger.warn(
          `Omnik production index ${guard.held.direction === 'down' ? 'drop' : 'jump'} held back: the "Accept the held index" button takes it`,
        );
      }
      // While a value is held, the last accepted one is sent again (no delta for the core).
      index = plausible ? total : guard.held ? guard.last?.value : undefined;
    }
    // The built index and its guard are in /data BEFORE Gladys gets the
    // value: a crash in between never sends an index /data does not know.
    await this.saveState();
    if (gone()) return;
    await this.publishStates(
      created,
      readingStates(external, reading, index, { energyToday: !stale }),
    );
  }

  /** The night: power 0, awake 0; the counters and the index are never sent. */
  async publishAsleep(gone) {
    const created = this.createdDevice();
    if (!created || gone()) {
      return;
    }
    await this.publishStates(created, asleepStates(this.external()));
  }

  async publishStates(created, states) {
    // Only the features the created device has (they are fixed at its creation).
    const features = created.features ? new Set(created.features.map((f) => f.external_id)) : null;
    const allowed = features
      ? states.filter((s) => features.has(s.device_feature_external_id))
      : states;
    if (allowed.length === 0) {
      return;
    }
    await this.gladys
      .publishChangedStates(allowed, { heartbeat: STATE_HEARTBEAT })
      .catch((err) => this.logger.warn(`Publishing the Omnik values failed: ${err.message}`));
  }

  // --- Configuration screen buttons -------------------------------------------------

  /**
   * The "Accept the held index" button: takes the value held as shown now
   * (plus what may come until the next read, src/guard.js), never anything
   * else. Published at the next read (never a read sooner).
   *
   * A DROP is never accepted (review 1, I2): the built index only drops when
   * the daily index takes back values already published, or when /data is
   * older than Gladys; it is never a new meter. Taking it would count the
   * climb back twice. The index corrects itself: it goes on once the
   * counter is back above the last value accepted.
   */
  async acceptHeldIndex() {
    const created = this.createdDevice();
    if (!created) {
      return T.accept.nothing;
    }
    const guard = this.guardOf(created, this.external().feature(FEATURE.PRODUCTION_INDEX));
    if (guard.held?.direction === 'down') {
      return T.accept.drop;
    }
    const taken = guard.acceptHeld();
    if (!taken) {
      return T.accept.nothing;
    }
    this.logger.info('Omnik production index jump accepted by the user');
    return T.accept.done(taken);
  }

  /**
   * The test button: never a read sooner than the pace allows. When a read
   * is due, this click makes it; otherwise it tells the last one. With
   * refused credentials, the click is the only read (one, at the pace):
   * a success lifts the refusal.
   */
  async testConnection() {
    if (!this.session?.client) {
      return this.config.invalidAddress ? T.badAddress : T.incomplete(missingOf(this.config));
    }
    if (this.pause && this.now() < this.pause.until) {
      return this.currentStatus()[1];
    }
    const refused = this.refusedNow();
    if (this.busy || this.dueAt() > this.monotonic()) {
      return refused
        ? T.test.refusedWait(Math.max(0, this.dueAt() - this.monotonic()))
        : this.describeOutcome();
    }
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve(T.test.slow), TEST_ANSWER_WITHIN);
    });
    try {
      return await Promise.race([
        this.tick({ manual: refused }).then(() => this.describeOutcome()),
        late,
      ]);
    } finally {
      this.timers.clearTimeout(timer);
      if (this.running) this.schedule();
    }
  }

  /** The last read in words, and the time to the next one. */
  describeOutcome() {
    const mono = this.monotonic();
    const next = Math.max(0, this.dueAt() - mono);
    const outcome = this.outcome;
    if (!outcome) {
      return T.test.notYet(next);
    }
    const ago = Math.max(0, mono - outcome.at);
    if (outcome.kind === 'reading') {
      const serial = this.info?.serial ?? '?';
      const { model } = outcome.reading;
      const power = within(outcome.reading.power, POWER_MAX) ?? '?';
      return T.test.reading({ serial, model, power }, ago, next);
    }
    if (this.refusedNow()) {
      return T.test.refused(this.config.address, ago);
    }
    if (outcome.kind === 'asleep') {
      return T.test.asleep(ago, next);
    }
    return T.test.failed(this.config.address, outcome.err, ago, next);
  }
}
