// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized: the
// address of the inverter's Wi-Fi logger, the source read (js, json, html,
// tcp, as the omnikinverter library), the logger's user name and password
// (web sources; required by html) or its serial number (tcp), and the optional
// peak power. The address parser comes from gladys-imeon / gladys-p1-monitor
// (approved).
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { SOURCES } from './omnik/model.js';

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * An address typed by the user: an IP address or a host name, with an
 * optional port. A pasted URL ("http://192.168.1.30/login") is reduced to its
 * host and port.
 * @returns {{ address: string } | { error: 'invalid' }} `address` is '' when empty.
 */
export function parseAddress(raw) {
  let text = String(raw ?? '').trim();
  if (text === '') {
    return { address: '' };
  }
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '');
  // user:password@ never belongs in the address: refused rather than sent around.
  if (text.includes('@')) {
    return { error: 'invalid' };
  }
  const bracketed = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i.exec(text);
  if (bracketed) {
    return withPort(`[${bracketed[1].toLowerCase()}]`, bracketed[2]);
  }
  if (/^[0-9a-f:.]+$/i.test(text) && (text.match(/:/g) ?? []).length >= 2) {
    return { address: `[${text.toLowerCase()}]` };
  }
  const match = /^(.*?)(?::(\d{1,5}))?$/.exec(text);
  const host = match[1];
  if (host.length > 253 || !host.split('.').every((label) => LABEL.test(label))) {
    return { error: 'invalid' };
  }
  return withPort(host.toLowerCase(), match[2]);
}

function withPort(host, port) {
  if (port === undefined) {
    return { address: host };
  }
  const number = Number(port);
  if (number < 1 || number > 65535) {
    return { error: 'invalid' };
  }
  return { address: number === 80 ? host : `${host}:${number}` };
}

/** A short text of the form (user name, password): trimmed for the name, bounded, else ''. */
const short = (raw, trim) => {
  if (typeof raw !== 'string' || raw.length > 128) return '';
  return trim ? raw.trim() : raw;
};

/** The logger's serial number (tcp): an integer from 1 to 4294967295 (4 bytes), else undefined. */
export function loggerSerialOf(raw) {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d{1,10}$/.test(text)) {
    return undefined;
  }
  const value = Number(text);
  return value >= 1 && value <= 0xffffffff ? value : undefined;
}

export function normalizeConfig(raw = {}) {
  // An address longer than any host name is refused before any parsing.
  const value = typeof raw?.address === 'string' && raw.address.length <= 300 ? raw.address : '';
  const parsed = parseAddress(value);
  const source = SOURCES.includes(raw?.source) ? raw.source : 'js';
  const username = short(raw?.username, true);
  const password = short(raw?.password, false);
  return {
    address: parsed.error ? '' : parsed.address,
    invalidAddress:
      Boolean(parsed.error) ||
      (typeof raw?.address === 'string' && value === '' && raw.address !== ''),
    peakKw: peakOf(raw?.peak_power_kw),
    source,
    username,
    password,
    loggerSerial: source === 'tcp' ? loggerSerialOf(raw?.logger_serial) : undefined,
  };
}

/**
 * What the logger is asked with, as a salted fingerprint (never the
 * password itself): a refusal kept in /data is lifted when it changes.
 * Only ever stored for a REFUSED set (lot 11), erased at the first success.
 */
export function credentialsFingerprint(config, salt) {
  return createHash('sha256')
    .update(`omnik-credentials:${salt}\u0000${config.source}\u0000`)
    .update(config.username)
    .update('\u0000')
    .update(config.password)
    .digest('hex')
    .slice(0, 32);
}

/**
 * The optional peak power of the installation (kWp, manifest `peak_power_kw`):
 * a number from 0.1 to 100, else undefined (the margin is then learned).
 */
export function peakOf(raw) {
  const text = typeof raw === 'string' ? raw.trim().replace(',', '.') : raw;
  if (text === '' || text === null || text === undefined) {
    return undefined;
  }
  if (typeof text === 'string' && !/^\d{1,3}(\.\d{1,3})?$/.test(text)) {
    return undefined;
  }
  const value = Number(text);
  return Number.isFinite(value) && value >= 0.1 && value <= 100 ? value : undefined;
}

/** Whether the form is complete enough to read the inverter. */
export const isComplete = (config) =>
  Boolean(config.address) &&
  (config.source !== 'tcp' || config.loggerSerial !== undefined) &&
  // The html page always asks for the logger's user name and password (as the library).
  (config.source !== 'html' || (config.username !== '' && config.password !== ''));

/** What is missing from the form, for the status: 'address', 'logger_serial' or 'credentials'. */
export function missingOf(config) {
  if (!config.address) return 'address';
  if (config.source === 'tcp' && config.loggerSerial === undefined) return 'logger_serial';
  if (config.source === 'html' && (config.username === '' || config.password === '')) {
    return 'credentials';
  }
  return undefined;
}
