// -----------------------------------------------------------------------------
// The parsers (src/omnik/model.js), against the fixtures of the omnikinverter
// library (the values its own tests expect) and hostile answers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boardOf,
  informationRequest,
  isComplete,
  parseHtml,
  parseJs,
  parseJson,
  parseTcp,
} from '../src/omnik/model.js';
import { LIBRARY, LOGGER_ID, bytes, page } from './fixtures/omnik.js';

test('js: the three layouts of the library', () => {
  assert.deepEqual(parseJs(LIBRARY.webdataJs), {
    kind: 'reading',
    serial: '12345678910',
    model: 'omnik4000tl2',
    firmware: 'NL2-V9.8-5931',
    power: 140,
    energyToday: 0.3,
    energyTotal: 15363.7,
    temperature: undefined,
    board: undefined,
  });
  const array = parseJs(LIBRARY.devicearrayJs);
  assert.equal(array.serial, '12345678910');
  assert.equal(array.model, 'Omnik1500tl');
  assert.equal(array.power, 850);
  assert.equal(array.energyToday, 2.32);
  assert.equal(array.energyTotal, 5200.2);
  const sofar = parseJs(LIBRARY.sofarJs);
  assert.equal(sofar.serial, '1234567890', 'spaces removed, as the library');
  assert.equal(sofar.power, 400);
  assert.equal(sofar.energyToday, 5.67);
  assert.equal(sofar.energyTotal, 12307);
});

test('json: the library fixture; day equal to total is the night', () => {
  assert.deepEqual(parseJson(LIBRARY.statusJson), {
    kind: 'reading',
    serial: undefined,
    model: 'omnik2000tl2',
    firmware: 'V1.25Build23261',
    power: 1225,
    energyToday: 10.9,
    energyTotal: 8674,
    temperature: undefined,
    board: undefined,
  });
  assert.deepEqual(parseJson(LIBRARY.wrongStatusJson), { kind: 'asleep', board: undefined });
});

test('html: the library fixtures, the logger told by a fingerprint only', () => {
  const omnik = parseHtml(LIBRARY.statusHtml);
  assert.equal(omnik.serial, '12345678910');
  assert.equal(omnik.model, 'Omnik2500tl');
  assert.equal(omnik.power, 219);
  assert.equal(omnik.energyToday, 0.23);
  assert.equal(omnik.energyTotal, 6454.5);
  assert.equal(omnik.board, boardOf('902000501'));
  assert.match(omnik.board, /^[0-9a-f]{12}$/);
  assert.ok(!JSON.stringify(omnik).includes('902000501'));
  const solis = parseHtml(LIBRARY.statusSolisHtml);
  assert.equal(solis.serial, '1234567890ABCDE');
  assert.equal(solis.power, 5850);
  assert.equal(solis.energyToday, 9.8);
  assert.equal(parseHtml(LIBRARY.wrongHtml), undefined);
  const night = parseHtml(page({ source: 'html', count: 0 }));
  assert.deepEqual(night, { kind: 'asleep', board: boardOf(LOGGER_ID) });
});

test('tcp: the three replies of the library', () => {
  const full = parseTcp(bytes(LIBRARY.tcpReply));
  assert.equal(full.kind, 'reading');
  assert.equal(full.serial, 'NLDN012345CS4321');
  assert.equal(full.temperature, 43.1);
  assert.equal(full.power, 2615);
  assert.equal(full.energyToday, 7.4);
  assert.equal(full.energyTotal, 65432.1);
  assert.match(full.board, /^[0-9a-f]{12}$/);
  const short = parseTcp(bytes(LIBRARY.tcpReplyNoFirmware));
  assert.equal(short.kind, 'reading');
  assert.equal(short.serial, 'NLDN202013212035');
  assert.equal(short.power, 0);
  assert.equal(short.energyToday, 7.21);
  assert.equal(short.energyTotal, 12861.9);
  assert.equal(short.temperature, 23.4);
  const offline = parseTcp(bytes(LIBRARY.tcpReplyOffline));
  assert.equal(offline.kind, 'asleep', 'an inverter not active: the night');
  // Trailing 0xFF after a reply is ignored; anything else after them is not.
  assert.equal(parseTcp(bytes(`${LIBRARY.tcpReply}ffffff`)).kind, 'reading');
  assert.equal(parseTcp(bytes(`${LIBRARY.tcpReply}ff00`)), undefined);
});

test('tcp: framing checked (start, separator, checksum, serial twice, end), linear', () => {
  const good = bytes(LIBRARY.tcpReply);
  const broken = (i, value) => {
    const copy = Uint8Array.from(good);
    copy[i] = value;
    return copy;
  };
  assert.equal(parseTcp(broken(0, 0x69)), undefined, 'start');
  assert.equal(parseTcp(broken(2, 0x40)), undefined, 'separator');
  assert.equal(parseTcp(broken(good.length - 2, 0x00)), undefined, 'checksum');
  assert.equal(parseTcp(broken(good.length - 1, 0x17)), undefined, 'end');
  assert.equal(parseTcp(broken(4, 0x00)), undefined, 'serial twice (and checksum)');
  assert.equal(parseTcp(good.subarray(0, 100)), undefined, 'cut');
  assert.equal(parseTcp(new Uint8Array(0)), undefined);
  assert.equal(parseTcp('68'), undefined);
  assert.equal(isComplete(good.subarray(0, 100)), false);
  assert.equal(isComplete(good), true);
  assert.equal(isComplete(new Uint8Array(0)), false);
  // A flood of start bytes is judged in linear steps.
  const flood = new Uint8Array(1024).fill(0x68);
  assert.equal(isComplete(flood), false);
  assert.equal(parseTcp(flood), undefined);
});

test('tcp: the request is the library one', () => {
  const request = informationRequest(987654321);
  assert.equal(Buffer.from(request).toString('hex'), '68024030b168de3ab168de3a0100d516');
  assert.equal(
    Buffer.from(informationRequest(4294967295)).toString('hex').slice(8, 24),
    'ffffffffffffffff',
  );
});

test('the night in the js source: the logger without inverter values', () => {
  assert.deepEqual(parseJs(page({ count: 0 })), { kind: 'asleep', board: undefined });
});

test('hostile or wrong answers: undefined, never a value read as 0', () => {
  const wrong = [
    '',
    'webData="1,2,3";',
    'var webData="12345678910,a,b,c,d,-5,30,153637,F13,0,";',
    'var webData="12345678910,a,b,c,d,12.5,30,153637,F13,0,";',
    'var webData="12345678910,a,b,c,d,140,abc,153637,F13,0,";',
    `var webData="${'1,'.repeat(100)}";`,
    'var webData="12345678910,a,b,c,d,140,30,153637',
    '{"__proto__":{"i_eday":"1"}}',
    '{"i_eday":{"x":1},"i_eall":"12"}',
    '[1,2]',
    'not json',
    '{"i_eday":"-1","i_eall":"12"}',
  ];
  for (const body of wrong) {
    const parsers =
      body.startsWith('{') || body.startsWith('[') || body === 'not json' ? [parseJson] : [parseJs];
    for (const parse of parsers) {
      const parsed = parse(body);
      assert.ok(
        parsed === undefined || (parsed.kind === 'reading' && parsed.energyToday === undefined),
        `${body.slice(0, 40)} -> ${JSON.stringify(parsed)}`,
      );
    }
  }
  // A serial with odd characters is not a serial (the app refuses the reading).
  assert.equal(parseJs(page({ serial: '<script>' })).serial, undefined);
  // Nothing read through the prototype.
  assert.equal(parseJson('{"__proto__":{"i_eday":"1","i_eall":"2"}}'), undefined);
  assert.equal(Object.prototype.i_eday, undefined);
  assert.equal(parseHtml(42), undefined);
  assert.equal(parseJs(null), undefined);
});

test('a huge answer is parsed in linear time', () => {
  const big = `var webData="${'9'.repeat(30_000)}`;
  const start = performance.now();
  assert.equal(parseJs(big), undefined);
  assert.equal(parseHtml(`webdata_sn="${' '.repeat(30_000)}`), undefined);
  assert.ok(performance.now() - start < 500);
});
