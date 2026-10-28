// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys (the real wiring of src/handlers.js),
// the fake charger of fakeSma.js and the virtual clock of the testkit: every
// read of the clock moves it (1 µs), and nothing fires unless the test moves
// it on.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { testClock, settle } from '../kit/index.mjs';
import { SmaApp } from '../../src/app.js';
import { SECOND } from '../../src/constants.js';
import { registerHandlers } from '../../src/handlers.js';
import { memoryStore } from '../../src/store.js';
import { HOST, NOW, PASSWORD, SERIAL, USER, fakeSma } from './fakeSma.js';

export { settle };
export const CONFIG = { host: HOST, username: USER, password: PASSWORD };
export const ALLOWED = { ...CONFIG, allow_commands: true };
export const DEVICE = `ext:test-integration:sma:${SERIAL}`;
export const feature = (role) => `${DEVICE}:${role}`;
export const READ = [
  'POST /api/v1/token',
  'POST /api/v1/measurements/live',
  'POST /api/v1/parameters/search',
];
export const READ_AGAIN = READ.slice(1);

export const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

/**
 * `clock`, `sma` and `store` may be shared between two lives (a restart).
 * `create`: the device is created in Gladys after the first read.
 */
export async function setup(
  t,
  {
    config = CONFIG,
    clock = testClock({ start: NOW }),
    sma,
    store = memoryStore(),
    create = true,
    logs = [],
    devices,
    getConfig,
    connect = true,
  } = {},
) {
  const charger = sma ?? fakeSma({ timers: clock.timers });
  const gladys = createFakeGladys({ config, ...(devices ? { devices } : {}) });
  if (getConfig) {
    gladys.getConfig = getConfig;
  }
  const app = new SmaApp({
    gladys,
    logger: recorder(logs),
    exchange: charger.exchange,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
  });
  registerHandlers(gladys, app);
  t.after(() => app.halt());
  const advance = async (ms, step = SECOND) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      await clock.advance(Math.min(step, ms - elapsed));
      await settle();
    }
  };
  if (connect) {
    await gladys.connect();
    await settle();
    await app.lifecycle;
    await settle();
  }
  if (create && gladys.fake.discoveredDevices.length > 0 && !devices) {
    await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
    await settle();
  }
  const target = (role) => {
    const device = gladys.fake.devices.find((d) => d.external_id === DEVICE);
    return [device, device.features.find((f) => f.external_id === feature(role))];
  };
  const send = (role, value = 1) => gladys.fake.setValue(...target(role), value);
  /** A command, the clock moved on until it answers (5 s at most, as Gladys waits). */
  const press = async (role, value = 1, wait = 5 * SECOND) => {
    const ack = send(role, value);
    await settle();
    await advance(wait, 50);
    return ack;
  };
  return { gladys, app, sma: charger, store, clock, advance, logs, press, send };
}

export const last = (gladys, role) => gladys.fake.lastState(feature(role));
export const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};
export const deviceOf = (gladys) => gladys.fake.discoveredDevices.at(-1);
