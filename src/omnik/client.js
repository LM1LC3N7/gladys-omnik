// -----------------------------------------------------------------------------
// The only network access: the Wi-Fi logger of an Omnik inverter on the home
// network, no cloud (as the omnikinverter library, see THIRD_PARTY_NOTICES.md):
// - a web source: one GET of /js/status.js, /status.json?CMD=inv_query or
//   /status.html, plain HTTP (the logger has no HTTPS), with the logger's
//   user name and password in Basic auth when they are given (required by
//   the html page);
// - the tcp source: one connection to port 8899, one request carrying the
//   logger's serial number, one reply.
// Read-only: nothing else is ever sent.
//
// Bounded: one request at a time, 10 s for the whole answer, 32 KiB (web) or
// 1 KiB (tcp) at most, read into one buffer allocated once, never a redirect
// followed. Node's own fetch and sockets: no User-Agent of ours, no imitation.
//
// Errors carry our own codes, never a text of the logger, a URL or a password.
// -----------------------------------------------------------------------------

import { createConnection } from 'node:net';
import { HTTP_TIMEOUT, MAX_BODY_BYTES, MAX_TCP_BYTES, TCP_PORT, WEB_PATHS } from '../constants.js';
import { PARSERS, informationRequest, isComplete, parseTcp } from './model.js';

export class OmnikError extends Error {
  /**
   * @param {'timeout'|'unreachable'|'http'|'not_found'|'server'|'rate_limited'|'too_large'|
   *   'unknown_answer'|'auth'} code
   */
  constructor(code, { status, retryAfter } = {}) {
    super(code);
    this.name = 'OmnikError';
    this.code = code;
    this.status = status;
    /** ms, from a Retry-After header (429, 503), when given. */
    this.retryAfter = retryAfter;
  }
}

/** A network failure (while connecting or while reading the body), in our words. */
function networkError(err) {
  if (err instanceof OmnikError) {
    return err;
  }
  const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
  return new OmnikError(timeout ? 'timeout' : 'unreachable');
}

/**
 * The body, up to `limit` bytes, copied into a single buffer allocated once
 * (no list of chunks, no concatenation): a longer one is not an Omnik answer.
 */
export async function readBounded(response, limit) {
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const buffer = new Uint8Array(limit);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (size + value.byteLength > limit) {
        throw new OmnikError('too_large');
      }
      buffer.set(value, size);
      size += value.byteLength;
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
  // As the library: ASCII, anything else dropped (latin1 keeps one char per byte).
  return new TextDecoder('latin1').decode(buffer.subarray(0, size));
}

/** The body of an answer we do not read: let go. */
const drop = async (response) => {
  try {
    await response.body?.cancel?.();
  } catch {
    // Nothing to do: the answer is refused anyway.
  }
};

/** Retry-After in seconds (or an HTTP date) -> ms, undefined when absent or odd. */
function retryAfterOf(response, now) {
  const raw = response.headers?.get?.('retry-after');
  if (typeof raw !== 'string' || raw.length > 64) {
    return undefined;
  }
  if (/^\d{1,9}$/.test(raw.trim())) {
    return Number(raw.trim()) * 1000;
  }
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now()) : undefined;
}

/** `host` and `port` of an address (`[v6]:port`, `host:port`, `host`), for a socket. */
export function hostPort(address, defaultPort) {
  const v6 = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i.exec(address);
  if (v6) {
    return { host: v6[1], port: v6[2] ? Number(v6[2]) : defaultPort };
  }
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(address);
  return { host: match?.[1] ?? address, port: match?.[2] ? Number(match[2]) : defaultPort };
}

export class OmnikClient {
  constructor({
    address,
    source = 'js',
    username = '',
    password = '',
    loggerSerial,
    fetchImpl = (...args) => globalThis.fetch(...args),
    connect = (options) => createConnection(options),
    timers = { setTimeout, clearTimeout },
    timeout = HTTP_TIMEOUT,
    now = Date.now,
  }) {
    this.address = address;
    this.source = source;
    // Kept in this object only: never logged, never in an error, never in /data.
    const credentials =
      username && password
        ? `Basic ${Buffer.from(`${username}:${password}`, 'latin1').toString('base64')}`
        : undefined;
    this.authorization = () => credentials;
    this.loggerSerial = loggerSerial;
    this.fetch = fetchImpl;
    this.connect = connect;
    this.timers = timers;
    this.timeout = timeout;
    this.now = now;
    /** Requests one after the other, never two at once (a small Wi-Fi logger). */
    this.queue = Promise.resolve();
  }

  serialize(run) {
    const job = this.queue.then(run, run);
    this.queue = job.catch(() => {});
    return job;
  }

  /** GET of the status page of the web source: its text, bounded. */
  request() {
    return this.serialize(async () => {
      try {
        const authorization = this.authorization();
        const response = await this.fetch(`http://${this.address}${WEB_PATHS[this.source]}`, {
          method: 'GET',
          // No header of ours (no User-Agent, no imitation), but the logger's own login.
          ...(authorization ? { headers: { authorization } } : {}),
          // A redirect is never followed: the request (and the password) stays on this address.
          redirect: 'manual',
          // The whole answer, the body included, within the timeout.
          signal: AbortSignal.timeout(this.timeout),
        });
        const status = response.status;
        if (status === 401 || status === 403) {
          await drop(response);
          throw new OmnikError('auth', { status });
        }
        if (status === 429 || status >= 500) {
          await drop(response);
          throw new OmnikError(status === 429 ? 'rate_limited' : 'server', {
            status,
            retryAfter: retryAfterOf(response, this.now),
          });
        }
        if (status === 404) {
          await drop(response);
          throw new OmnikError('not_found', { status });
        }
        if (status < 200 || status >= 300) {
          await drop(response);
          throw new OmnikError('http', { status });
        }
        return await readBounded(response, MAX_BODY_BYTES);
      } catch (err) {
        throw networkError(err);
      }
    });
  }

  /**
   * The tcp source: the request, then the reply until it is complete (the
   * library's `is_complete`), bounded in size and in time. The bytes received.
   */
  tcpRequest() {
    return this.serialize(
      () =>
        new Promise((resolve, reject) => {
          const buffer = new Uint8Array(MAX_TCP_BYTES);
          let size = 0;
          let settled = false;
          let socket;
          const finish = (err) => {
            if (settled) return;
            settled = true;
            this.timers.clearTimeout(timer);
            try {
              socket?.destroy();
            } catch {
              // Already closed.
            }
            if (err) reject(err);
            else resolve(buffer.slice(0, size));
          };
          const timer = this.timers.setTimeout(
            () => finish(new OmnikError('timeout')),
            this.timeout,
          );
          try {
            socket = this.connect(hostPort(this.address, TCP_PORT));
          } catch {
            finish(new OmnikError('unreachable'));
            return;
          }
          socket.on('connect', () => {
            socket.write(informationRequest(this.loggerSerial));
          });
          socket.on('data', (chunk) => {
            if (settled) return;
            if (size + chunk.length > MAX_TCP_BYTES) {
              finish(new OmnikError('too_large'));
              return;
            }
            buffer.set(chunk, size);
            size += chunk.length;
            if (isComplete(buffer.subarray(0, size))) {
              finish();
            }
          });
          socket.on('error', (err) => finish(networkError(err)));
          // Closed by the logger: what came is parsed (a cut reply is refused there).
          socket.on('close', () => finish(size > 0 ? undefined : new OmnikError('unreachable')));
        }),
    );
  }

  /** The status of the inverter (src/omnik/model.js); `unknown_answer` when it is not one. */
  async readStatus() {
    const reading =
      this.source === 'tcp'
        ? parseTcp(await this.tcpRequest())
        : PARSERS[this.source](await this.request());
    if (!reading) {
      throw new OmnikError('unknown_answer');
    }
    return reading;
  }
}
