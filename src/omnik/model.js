// -----------------------------------------------------------------------------
// The local answers of an Omnik inverter's Wi-Fi logger -> values. Pure.
//
// Ported from the omnikinverter library (Klaas Schoute, MIT, see
// THIRD_PARTY_NOTICES.md), `Inverter.from_js`, `from_json`, `from_html`,
// `from_tcp` and `tcp.py`. Four sources, as the library reads them:
//
// - `js`   GET /js/status.js: `webData="..."` (or `myDeviceArray[0]="..."`),
//          fields separated by commas: 0 serial, 1 firmware, 2 slave firmware,
//          3 model, 4 rated power (W), 5 power (W), 6 energy of the day
//          (0.01 kWh), 7 energy total (0.1 kWh), 8 alarm code;
// - `json` GET /status.json?CMD=inv_query: i_sn, i_modle, i_ver_m, i_pow,
//          i_pow_n (W), i_eday (kWh), i_eall (kWh), i_alarm;
// - `html` GET /status.html: `var webdata_<key> = "...";` (spaces removed),
//          webdata_now_p (W), webdata_today_e (kWh), webdata_total_e (kWh)...
//          and cover_mid, the id of the logger;
// - `tcp`  port 8899: one binary request carrying the logger's serial number,
//          one or more framed messages in reply (see `parseTcp`).
//
// A reading is `{ kind: 'reading', serial, model, firmware, power, energyToday,
// energyTotal, temperature, board }` (values undefined when not given) or
// `{ kind: 'asleep', board }` (the logger answers, its inverter gives nothing:
// the night); undefined when the answer is not one of these.
//
// Hostile answers: the caller bounds the size (src/omnik/client.js); every
// search here is a linear `indexOf`, no regular expression runs over the whole
// answer, no object is built from the answer's own keys, every value is
// checked against a strict pattern, nothing is ever read as 0 by default.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { MAX_FIELDS } from '../constants.js';

/** The sources, as the manifest's `source` select names them. */
export const SOURCES = ['js', 'json', 'html', 'tcp'];

const SERIAL = /^[A-Za-z0-9_-]{4,40}$/;
const TEXT = /^[A-Za-z0-9._()+:-]{1,48}$/;
const INTEGER = /^\d{1,9}$/;
const DECIMAL = /^\d{1,9}(\.\d{1,4})?$/;

/**
 * A short fingerprint of the id of the Wi-Fi logger (html `cover_mid`, the
 * serial of the logger in a TCP reply): tells one logger from another (a page
 * without inverter carries no serial), without keeping the id itself.
 */
export function boardOf(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(id)
    ? createHash('sha256').update(`omnik-logger:${id}`).digest('hex').slice(0, 12)
    : undefined;
}

const serialOf = (text) => (typeof text === 'string' && SERIAL.test(text) ? text : undefined);
const textOf = (text) => (typeof text === 'string' && TEXT.test(text) ? text : undefined);

/** The logger's own "no value" (its status page shows it as ---): review 1, I3. */
const NO_VALUE = 4294967295;

/**
 * A number as written: '' or the logger's 4294967295 is not given (null), a
 * wrong one (a bad text, an object, an array) is a wrong answer (NaN).
 */
function numberOf(raw, pattern = DECIMAL) {
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  if (raw === NO_VALUE || raw === String(NO_VALUE)) {
    return null;
  }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? raw : Number.NaN;
  }
  return typeof raw === 'string' && pattern.test(raw) ? Number(raw) : Number.NaN;
}

/** `value / by` for a number given, the marker (null, NaN) unchanged. */
const scaled = (value, by) =>
  typeof value === 'number' && !Number.isNaN(value) ? value / by : value;

/** A reading from the values found; undefined when one of them is wrong. */
function reading(values, board) {
  for (const key of ['power', 'energyToday', 'energyTotal']) {
    if (Number.isNaN(values[key])) {
      return undefined;
    }
  }
  const given = (value) => (value === null ? undefined : value);
  if (values.power === null && values.energyToday === null) {
    // Neither a power nor a counter of the day (empty, or 4294967295), even
    // with a serial: the night (review 1, I3).
    return { kind: 'asleep', board };
  }
  const rated = values.rated === null || Number.isNaN(values.rated) ? undefined : values.rated;
  return {
    kind: 'reading',
    serial: values.serial,
    model: values.model,
    firmware: values.firmware,
    power: given(values.power),
    energyToday: given(values.energyToday),
    energyTotal: given(values.energyTotal),
    temperature: values.temperature,
    rated,
    board,
  };
}

/** The text between `marker` and the next `";`, linear; undefined when absent. */
function quoted(text, marker) {
  const start = text.indexOf(marker);
  if (start < 0) {
    return undefined;
  }
  const from = start + marker.length;
  const end = text.indexOf('";', from);
  return end < 0 ? undefined : text.slice(from, end);
}

// --- js ------------------------------------------------------------------------------

export function parseJs(text) {
  if (typeof text !== 'string') {
    return undefined;
  }
  // As the library: `webData` when the page has it, else `myDeviceArray[0]`.
  const data =
    text.indexOf('webData') !== -1 ? quoted(text, 'webData="') : quoted(text, 'myDeviceArray[0]="');
  if (data === undefined) {
    return undefined;
  }
  const fields = data.split(',', MAX_FIELDS + 1);
  if (fields.length > MAX_FIELDS || fields.length < 9) {
    return undefined;
  }
  // The library removes the spaces of each field ("2 000" -> 2000).
  const f = fields.map((field) => field.replaceAll(' ', ''));
  if (f[0] === '' && f[5] === '' && f[6] === '') {
    // The logger answers, its inverter gives nothing: the night.
    return { kind: 'asleep', board: undefined };
  }
  return reading(
    {
      serial: serialOf(f[0]),
      firmware: textOf(f[1]),
      model: textOf(f[3]),
      rated: numberOf(f[4], INTEGER),
      power: numberOf(f[5], INTEGER),
      // 0.01 kWh and 0.1 kWh, as the library divides them.
      energyToday: scaled(numberOf(f[6]), 100),
      energyTotal: scaled(numberOf(f[7]), 10),
    },
    undefined,
  );
}

// --- json ----------------------------------------------------------------------------

export function parseJson(text) {
  if (typeof text !== 'string') {
    return undefined;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return undefined;
  }
  // Own keys only: nothing read through the prototype. A value that is
  // neither a text nor a number (an object, an array, a boolean) is kept as
  // it is: a wrong answer for a number (review 1, M3), no text.
  const get = (key) => (Object.hasOwn(data, key) ? data[key] : undefined);
  if (get('i_eday') === undefined && get('i_eall') === undefined) {
    return undefined;
  }
  const today = numberOf(get('i_eday'));
  const total = numberOf(get('i_eall'));
  if (today === total) {
    // The library refuses an answer whose day and total are equal (seen at
    // night or at start, 0.0 and 0.0): the inverter gives nothing.
    return { kind: 'asleep', board: undefined };
  }
  const serial = get('i_sn');
  return reading(
    {
      serial: serialOf(typeof serial === 'string' ? serial.trim() : undefined),
      firmware: textOf(get('i_ver_m')),
      model: textOf(get('i_modle')),
      rated: numberOf(get('i_pow'), INTEGER),
      power: numberOf(get('i_pow_n'), INTEGER),
      energyToday: today,
      energyTotal: total,
    },
    undefined,
  );
}

// --- html ----------------------------------------------------------------------------

const HTML_KEYS = [
  'webdata_sn',
  'webdata_msvn',
  'webdata_pv_type',
  'webdata_now_p',
  'webdata_today_e',
  'webdata_total_e',
];

export function parseHtml(text) {
  if (typeof text !== 'string') {
    return undefined;
  }
  // As the library: the spaces removed first.
  const data = text.replaceAll(' ', '');
  const v = {};
  for (const key of HTML_KEYS) {
    const value = quoted(data, `${key}="`);
    if (value === undefined) {
      return undefined;
    }
    v[key] = value;
  }
  const board = boardOf(quoted(data, 'cover_mid="'));
  const rated = quoted(data, 'webdata_rate_p="');
  if (v.webdata_sn === '' && v.webdata_now_p === '' && v.webdata_today_e === '') {
    return { kind: 'asleep', board };
  }
  return reading(
    {
      serial: serialOf(v.webdata_sn),
      firmware: textOf(v.webdata_msvn),
      model: textOf(v.webdata_pv_type),
      rated: numberOf(rated, INTEGER),
      power: numberOf(v.webdata_now_p, INTEGER),
      energyToday: numberOf(v.webdata_today_e),
      energyTotal: numberOf(v.webdata_total_e),
    },
    board,
  );
}

// --- tcp -----------------------------------------------------------------------------

const MESSAGE_START = 0x68;
const MESSAGE_END = 0x16;
const MESSAGE_SEND_SEP = 0x40;
const MESSAGE_RECV_SEP = 0x41;
const TYPE_INFORMATION_REQUEST = 0x30;
const TYPE_INFORMATION_REPLY = 0xb0;
const TYPE_STRING = 0xf0;
const UINT16_MAX = 0xffff;
/** Length byte, separator, type, the serial twice (2 x 4 bytes), checksum. */
const HEADER_SIZE = 3 + 2 * 4 + 1;
/** The information reply without its optional firmware strings (the library's `_TcpData`). */
const TCP_DATA_SIZE = 85;
/** The temperature an offline inverter gives (the library sets it to None). */
const TEMPERATURE_OFFLINE = 65326;

/** The request for the statistics: the logger's serial number, as the library packs it. */
export function informationRequest(loggerSerial) {
  const serial = [0, 8, 16, 24].map((shift) => (loggerSerial >>> shift) & 0xff);
  const body = [2, MESSAGE_SEND_SEP, TYPE_INFORMATION_REQUEST, ...serial, ...serial, 0x01, 0x00];
  const checksum = body.reduce((sum, b) => sum + b, 0) & 0xff;
  return Uint8Array.from([MESSAGE_START, ...body, checksum, MESSAGE_END]);
}

/** Whether `data` holds only complete messages (the library's `is_complete`), linear. */
export function isComplete(data) {
  let position = 0;
  while (position < data.length) {
    if (data[position] !== MESSAGE_START) {
      // Trailing 0xFF garbage or a wrong start byte: left to parseTcp.
      return true;
    }
    if (position + 1 >= data.length) {
      return false;
    }
    position += 1 + data[position + 1] + HEADER_SIZE + 1;
  }
  return position > 0 && position <= data.length;
}

/**
 * The fields of an information reply (the library's `_TcpData.parse`), big
 * endian: the serial of the inverter, the temperature, the AC powers, the
 * energy of the day (0.01 kWh), the energy total (0.1 kWh), whether the
 * inverter is active. Undefined when it is not one.
 */
function informationOf(payload) {
  if (payload.length < TCP_DATA_SIZE) {
    return undefined;
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const u16 = (at) => view.getUint16(at, false);
  let serial = '';
  for (let i = 3; i < 19 && payload[i] !== 0; i += 1) {
    serial += String.fromCharCode(payload[i]);
  }
  const temperature = u16(19);
  const powers = [47, 51, 55].map(u16).filter((p) => p !== UINT16_MAX);
  const active = u16(67);
  if (active !== 0 && active !== 1) {
    return undefined;
  }
  return {
    serial: serial.trim(),
    temperature: temperature === TEMPERATURE_OFFLINE ? undefined : temperature / 10,
    power: powers.reduce((sum, p) => sum + p, 0),
    energyToday: u16(57) / 100,
    energyTotal: view.getUint32(59, false) / 10,
    active: active === 1,
  };
}

/**
 * The reply of the logger (the library's `parse_messages`): framed messages
 * `0x68 len 0x41 type serial serial payload checksum 0x16`, checked one by one
 * (start, separator, checksum, the serial twice, end), trailing 0xFF ignored,
 * text messages ignored. Undefined when it is not a valid reply with
 * statistics in it.
 */
export function parseTcp(data) {
  if (!(data instanceof Uint8Array)) {
    return undefined;
  }
  let info;
  let logger;
  let position = 0;
  while (position < data.length) {
    const start = data[position];
    if (start === 0xff && info) {
      // Trailing 0xFF garbage after a reply: only 0xFF may follow.
      for (let i = position; i < data.length; i += 1) {
        if (data[i] !== 0xff) return undefined;
      }
      break;
    }
    if (start !== MESSAGE_START || position + 1 >= data.length) {
      return undefined;
    }
    const length = data[position + 1] + HEADER_SIZE;
    const end = position + 1 + length;
    if (end >= data.length || data[end] !== MESSAGE_END) {
      return undefined;
    }
    const message = data.subarray(position + 1, end);
    let sum = 0;
    for (let i = 0; i < length - 1; i += 1) sum += message[i];
    if ((sum & 0xff) !== message[length - 1] || message[1] !== MESSAGE_RECV_SEP) {
      return undefined;
    }
    const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
    const serial0 = view.getUint32(3, true);
    if (serial0 !== view.getUint32(7, true)) {
      return undefined;
    }
    const type = message[2];
    if (type === TYPE_INFORMATION_REPLY) {
      info = informationOf(message.subarray(11, length - 1));
      if (!info) return undefined;
      logger = serial0;
    } else if (type !== TYPE_STRING) {
      return undefined;
    }
    position = end + 1;
  }
  if (!info) {
    return undefined;
  }
  const board = boardOf(String(logger));
  if (!info.active) {
    // The logger answers, the inverter is not active: the night.
    return { kind: 'asleep', board };
  }
  return reading(
    {
      serial: serialOf(info.serial),
      firmware: undefined,
      model: undefined,
      power: info.power,
      energyToday: info.energyToday,
      energyTotal: info.energyTotal,
      temperature: info.temperature,
    },
    board,
  );
}

/** The parser of a web source. */
export const PARSERS = { js: parseJs, json: parseJson, html: parseHtml };
