// -----------------------------------------------------------------------------
// 0.1.3: an inverter whose midnight comes before ours (midnight sun, its clock
// ahead of the container, TZ Europe/Oslo): the mark of the day before is
// dated by the night it starts, the day before shown again is never counted.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

// The time zone of the container, read by src/constants.js when it loads.
process.env.TZ = 'Europe/Oslo';
const { P, replay } = await import('./helpers/app.js');
const { midnightSun } = await import('./helpers/earlyMidnight.js');
const { TIME_ZONE } = await import('../src/constants.js');

test('the container runs on Europe/Oslo', () => {
  assert.equal(TIME_ZONE, 'Europe/Oslo');
});

for (const ahead of [0, 20, 55]) {
  test(`midnight sun, the inverter resets at its midnight, its clock ${ahead} min ahead`, async () => {
    const { world, real } = midnightSun(ahead);
    const from = P(0, 10);
    const until = P(3, 20);
    const result = await replay({ days: [], world, from, until });
    const expected = real(from, until);
    assert.ok(result.counted <= expected + 0.02, `counted ${result.counted} > real ${expected}`);
    assert.ok(result.counted >= expected - 0.3, `counted ${result.counted} << real ${expected}`);
  });
}
