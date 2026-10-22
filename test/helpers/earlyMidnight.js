// -----------------------------------------------------------------------------
// Worlds of the "inverter's midnight before ours" check (0.1.3, after the
// gladys-imeon 0.1.2 review): a power profile integrated minute by minute, a
// counter reset at the inverter's own instant, a 1-hour outage at the house's
// noon, then the counter of the day before shown again for 15 minutes.
// -----------------------------------------------------------------------------

import { HOUR, MINUTE, P, printed } from './app.js';

const DAY = 24 * HOUR;

function makeWorld({ power, resetBefore, asleep, noonOutage, staleFor = 15 * MINUTE }) {
  const T0 = P(-2, 0);
  // Energy since T0, by 1-minute steps, cached.
  const steps = [0];
  const cumAt = (k) => {
    for (let j = steps.length - 1; j < k; j += 1) {
      steps.push(steps[j] + power(T0 + j * MINUTE) / 60);
    }
    return steps[k];
  };
  const cum = (t) => {
    const k = Math.floor((t - T0) / MINUTE);
    return cumAt(k) + (power(T0 + k * MINUTE) * ((t - T0) % MINUTE)) / HOUR;
  };
  const counter = (t) => Math.floor((cum(t) - cum(resetBefore(t))) * 100 + 1e-9) / 100;
  const world = (t) => {
    if (asleep(t)) return 'timeout';
    const [a, b] = noonOutage(t);
    if (t > a && t <= b) return 'timeout';
    if (t > b && t <= b + staleFor) {
      const r = resetBefore(t);
      return { power: Math.round(power(t) * 1000), energy: printed(counter(r - 1)) };
    }
    return { power: Math.round(power(t) * 1000), energy: printed(counter(t)) };
  };
  return { world, real: (t0, t1) => cum(t1) - cum(t0) };
}

/** Midnight sun: the inverter never sleeps and resets at ITS midnight, its clock `ahead` min ahead. */
export function midnightSun(ahead) {
  const invDay = (t) => Math.floor((t + ahead * MINUTE - P(0, 0)) / DAY);
  const scale = (t) => [1, 0.6, 1, 1][Math.max(0, Math.min(3, invDay(t)))];
  const hour = (t) => ((((t - P(0, 0)) / HOUR) % 24) + 24) % 24;
  return makeWorld({
    power: (t) =>
      scale(t) * (0.3 + (2.7 * (1 + Math.cos((2 * Math.PI * (hour(t) - 13)) / 24))) / 2),
    resetBefore: (t) => P(0, 0) + invDay(t) * DAY - ahead * MINUTE,
    asleep: () => false,
    noonOutage: () => [P(1, 11), P(1, 12)],
  });
}

/** A house 7 h east of the container (UTC): wakes up and resets at 23:30 container time. */
export function eastHouse() {
  const rise = (d) => P(d, 1.5);
  const set = (d) => rise(d) + 12 * HOUR;
  const dayOf = (t) => Math.floor((t - P(0, 1.5)) / DAY);
  const scale = (d) => [1, 0.6, 1, 1][Math.max(0, Math.min(3, d))];
  return makeWorld({
    power: (t) => {
      const d = dayOf(t);
      const x = (t - rise(d)) / (set(d) - rise(d));
      return x <= 0 || x >= 1 ? 0 : scale(d) * 3 * Math.sin(Math.PI * x);
    },
    resetBefore: (t) => rise(dayOf(t)),
    asleep: (t) => {
      const d = dayOf(t);
      return t <= rise(d) || t >= set(d);
    },
    noonOutage: () => [P(1, 7.5) - HOUR, P(1, 7.5)],
  });
}
