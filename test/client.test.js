// -----------------------------------------------------------------------------
// The only network access (src/omnik/client.js): bounded, our own error
// codes, one GET of the page of the source (or one tcp request), never a
// redirect followed, the password only in the Authorization header.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { OmnikClient, OmnikError, hostPort, readBounded } from '../src/omnik/client.js';
import { MAX_BODY_BYTES, MAX_TCP_BYTES } from '../src/constants.js';
import { ADDRESS, LIBRARY, bytes, page, text } from './fixtures/omnik.js';
import { createFetch, refusedError, streamOf, timeoutError } from './helpers/fakeNet.js';

const client = (handler, options = {}) => {
  const net = createFetch(handler);
  return { net, client: new OmnikClient({ address: ADDRESS, fetchImpl: net.fetch, ...options }) };
};

const codeOf = async (promise) => {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof OmnikError, String(err));
    return err;
  }
  assert.fail('no error');
};

test('js: one GET of /js/status.js, no redirect followed, within a timeout, no header', async () => {
  const { net, client: c } = client(() => text(page()));
  const reading = await c.readStatus();
  assert.equal(reading.power, 226);
  assert.equal(net.calls.length, 1);
  const [call] = net.calls;
  assert.equal(call.host, ADDRESS);
  assert.equal(call.path, '/js/status.js');
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.redirect, 'manual');
  assert.ok(call.init.signal instanceof AbortSignal);
  assert.equal(call.init.headers, undefined, 'no header of ours: no User-Agent, no imitation');
});

test('the path of each web source, the login in Basic auth only when given', async () => {
  const seen = [];
  for (const source of ['json', 'html']) {
    const net = createFetch(({ path, init }) => {
      seen.push({ path, init });
      return text(source === 'json' ? LIBRARY.statusJson : LIBRARY.statusHtml);
    });
    const c = new OmnikClient({
      address: ADDRESS,
      source,
      username: 'admin',
      password: 'pässword',
      fetchImpl: net.fetch,
    });
    assert.equal((await c.readStatus()).kind, 'reading');
  }
  assert.equal(seen[0].path, '/status.json');
  assert.equal(seen[1].path, '/status.html');
  const expected = `Basic ${Buffer.from('admin:pässword', 'latin1').toString('base64')}`;
  assert.equal(seen[1].init.headers.authorization, expected);
  // The password is nowhere but in that header.
  const c = new OmnikClient({ address: ADDRESS, username: 'admin', password: 'secret-pw' });
  assert.ok(!JSON.stringify(c).includes('secret-pw'));
  assert.ok(!JSON.stringify(c).includes(Buffer.from('admin:secret-pw').toString('base64')));
});

test('errors in our own words', async () => {
  const cases = [
    [() => text('x', { status: 404 }), 'not_found'],
    [() => text('x', { status: 302, headers: { location: 'http://evil.example/' } }), 'http'],
    [() => text('x', { status: 401 }), 'auth'],
    [() => text('x', { status: 403 }), 'auth'],
    [() => text('x', { status: 503, headers: { 'retry-after': '120' } }), 'server'],
    [() => text('x', { status: 429 }), 'rate_limited'],
    [() => text('<html>login</html>'), 'unknown_answer'],
    [
      () => {
        throw refusedError();
      },
      'unreachable',
    ],
    [
      () => {
        throw timeoutError();
      },
      'timeout',
    ],
  ];
  for (const [handler, code] of cases) {
    const err = await codeOf(client(handler).client.readStatus());
    assert.equal(err.code, code);
    assert.doesNotMatch(err.message, /evil|login|http:/);
  }
  const err = await codeOf(
    client(() => text('x', { status: 503, headers: { 'retry-after': '120' } })).client.readStatus(),
  );
  assert.equal(err.retryAfter, 120_000);
  assert.equal(err.status, 503);
});

test('a body larger than the limit is refused, read in one buffer', async () => {
  const many = new Response(streamOf(10_000, 64), { status: 200 });
  const err = await codeOf(readBounded(many, MAX_BODY_BYTES));
  assert.equal(err.code, 'too_large');
  const { client: c } = client(() => new Response(streamOf(100, 1024)));
  assert.equal((await codeOf(c.readStatus())).code, 'too_large');
  // Exactly at the limit: read.
  const exact = new Response(streamOf(32, 1024));
  assert.equal((await readBounded(exact, MAX_BODY_BYTES)).length, MAX_BODY_BYTES);
});

test('requests one after the other', async () => {
  let running = 0;
  let most = 0;
  const { client: c } = client(async () => {
    running += 1;
    most = Math.max(most, running);
    await new Promise((resolve) => setImmediate(resolve));
    running -= 1;
    return text(page());
  });
  await Promise.all([c.readStatus(), c.readStatus(), c.readStatus()]);
  assert.equal(most, 1);
});

// --- tcp -----------------------------------------------------------------------------

/** A fake socket: `script(socket, request)` answers the request. */
function fakeConnect(script) {
  const calls = [];
  const connect = (options) => {
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.destroy = () => {
      socket.destroyed = true;
    };
    socket.write = (data) => {
      calls.at(-1).written = Buffer.from(data).toString('hex');
      setImmediate(() => script(socket, data));
    };
    calls.push({ options, socket });
    setImmediate(() => socket.emit('connect'));
    return socket;
  };
  return { connect, calls };
}

const tcpClient = (script, options = {}) => {
  const fake = fakeConnect(script);
  return {
    fake,
    client: new OmnikClient({
      address: ADDRESS,
      source: 'tcp',
      loggerSerial: 987654321,
      connect: fake.connect,
      ...options,
    }),
  };
};

test('tcp: the request of the library, the reply in pieces, the socket closed', async () => {
  const reply = bytes(LIBRARY.tcpReply);
  const { fake, client: c } = tcpClient((socket) => {
    // The reply in three segments.
    socket.emit('data', Buffer.from(reply.subarray(0, 10)));
    socket.emit('data', Buffer.from(reply.subarray(10, 100)));
    socket.emit('data', Buffer.from(reply.subarray(100)));
  });
  const reading = await c.readStatus();
  assert.equal(reading.kind, 'reading');
  assert.equal(reading.serial, 'NLDN012345CS4321');
  assert.equal(reading.power, 2615);
  assert.equal(reading.energyToday, 7.4);
  assert.equal(reading.temperature, 43.1);
  const [call] = fake.calls;
  assert.deepEqual(call.options, { host: ADDRESS, port: 8899 });
  // 0x68 len 0x40 0x30 serial(LE) serial(LE) 01 00 checksum 0x16 (as the library packs it).
  assert.equal(call.written, '68024030b168de3ab168de3a0100d516');
  assert.ok(call.socket.destroyed);
});

test('tcp: errors in our own words, bounded in size and time', async () => {
  const refused = tcpClient((socket) => {
    socket.emit(
      'error',
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    );
  });
  assert.equal((await codeOf(refused.client.readStatus())).code, 'unreachable');
  const garbage = tcpClient((socket) => {
    socket.emit('data', Buffer.from('68ffffff', 'hex'));
    socket.emit('close');
  });
  assert.equal((await codeOf(garbage.client.readStatus())).code, 'unknown_answer');
  const flood = tcpClient((socket) => {
    for (let i = 0; i < 10; i += 1) socket.emit('data', Buffer.alloc(200, 0x68));
  });
  assert.equal((await codeOf(flood.client.readStatus())).code, 'too_large');
  assert.ok(MAX_TCP_BYTES < 2000);
  // Silent: the timeout of the client (fake timers).
  let fire;
  const silent = tcpClient(() => {}, {
    timers: {
      setTimeout: (fn) => {
        fire = fn;
        return 1;
      },
      clearTimeout: () => {},
    },
  });
  const pending = codeOf(silent.client.readStatus());
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  fire();
  assert.equal((await pending).code, 'timeout');
});

test('hostPort: IPv4, names, IPv6 and a port typed', () => {
  assert.deepEqual(hostPort('192.168.1.70', 8899), { host: '192.168.1.70', port: 8899 });
  assert.deepEqual(hostPort('logger.lan:9000', 8899), { host: 'logger.lan', port: 9000 });
  assert.deepEqual(hostPort('[fe80::1]', 8899), { host: 'fe80::1', port: 8899 });
  assert.deepEqual(hostPort('[fe80::1]:9000', 8899), { host: 'fe80::1', port: 9000 });
});
