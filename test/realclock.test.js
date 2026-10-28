// -----------------------------------------------------------------------------
// The real clock, sped up 20 times, the real transport and a real HTTPS
// charger on the loopback: the reads come at the interval (never sooner,
// never one late), the token is asked once, and a stop goes at once.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SmaApp } from '../src/app.js';
import { memoryStore } from '../src/store.js';
import { httpsServer, measurePeriod, realClock, reply, spyOn } from './kit/index.mjs';
import { measurementsOf, parametersOf } from './helpers/fakeSma.js';

test('real clock x20: one read per interval, measured', async (t) => {
  const state = {
    serial: '1234567890',
    session: 200113,
    health: 307,
    rotary: 4950,
    power: 7200,
    currents: [10, 10, 10],
    voltages: [230, 230, 230],
    meterWh: 1_000_000,
    sessionWh: 1000,
    mode: '4718',
    possibleModes: ['4718', '4721'],
    limit: '16.000',
    limitMin: 6,
    limitMax: 32,
    rated: '32.000',
  };
  const srv = await httpsServer({
    routes: {
      'POST /api/v1/token': () => ({ access_token: 'tok-1', expires_in: 3600 }),
      'POST /api/v1/measurements/live': (r) =>
        r.headers.authorization === 'Bearer tok-1' ? measurementsOf(state) : reply(401, ''),
      'POST /api/v1/parameters/search': (r) =>
        r.headers.authorization === 'Bearer tok-1' ? parametersOf(state) : reply(401, ''),
      'PUT /api/v1/parameters/IGULD:SELF': (r) => {
        state.mode = r.json.values[0].value;
        return reply(204, '');
      },
    },
  });
  const clock = realClock({ speed: 20 });
  const gladys = createFakeGladys({
    config: { host: `127.0.0.1:${srv.port}`, username: 'u', password: 'p', poll_interval: 30 },
  });
  const app = new SmaApp({
    gladys,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: memoryStore(),
  });
  t.after(async () => {
    app.halt();
    clock.close();
    await srv.close();
  });
  const spy = spyOn(app, 'markRead', clock);
  await app.connected(gladys.fake.config);
  const gaps = await measurePeriod(spy, { count: 4, period: 30_000 });
  assert.equal(gaps.length, 3);
  assert.equal(srv.count('POST /api/v1/token'), 1);
  // The stop: no option, at once, through the same pinned certificate.
  const device = gladys.fake.discoveredDevices[0];
  const stop = device.features.find((f) => f.external_id.endsWith(':stop-charge'));
  await app.setValue(device, stop, 1);
  assert.equal(state.mode, '4721');
});
