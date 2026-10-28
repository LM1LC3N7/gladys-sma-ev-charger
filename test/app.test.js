// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys, a fake charger behind the injected `exchange`, and a virtual clock
// (each read moves it 1 µs; the tests move it on).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { ACTIONS, HOUR, MINUTE, SECOND } from '../src/constants.js';
import { CHARGING_STATE, CONNECTOR_STATUS } from '../src/devices.js';
import { memoryStore } from '../src/store.js';
import { FP, HOST, OTHER_FP, PASSWORD, SERIAL, USER } from './helpers/fakeSma.js';
import {
  ALLOWED,
  CONFIG,
  READ,
  READ_AGAIN,
  deviceOf,
  feature,
  last,
  message,
  settle,
  setup,
} from './helpers/app.js';

/** No secret anywhere a user or a log reader may see. */
function assertNoSecret({ gladys, logs, store }) {
  const seen = JSON.stringify([logs, gladys.fake.connectionStatuses, store.data]);
  assert.ok(!seen.includes(PASSWORD), 'the password leaked');
  assert.ok(!seen.includes(USER), 'the user name leaked');
  assert.ok(!seen.includes('tok-'), 'the access token leaked');
}

test('without an address or credentials, the status asks for them and nothing is requested', async (t) => {
  const ctx = await setup(t, { config: {} });
  const { gladys, app, sma } = ctx;
  assert.match(message(gladys).fr, /adresse IP/);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /IP address/);
  // A password without a user name is refused (and the other way round).
  await app.configUpdated({ host: HOST, password: PASSWORD });
  assert.match(message(gladys).en, /user name AND the password/);
  await app.configUpdated({ host: HOST, username: USER });
  assert.match(message(gladys).en, /user name AND the password/);
  await app.configUpdated({
    host: `${USER}:${PASSWORD}@${HOST}`,
    username: USER,
    password: PASSWORD,
  });
  assert.match(message(gladys).en, /holds a user name or a password/);
  await app.configUpdated({ host: '255.255.255.255', username: USER, password: PASSWORD });
  assert.match(message(gladys).en, /is not an IP address/);
  assert.equal(sma.connections.length, 0);
  assertNoSecret(ctx);
});

test('one read: token, measurements, parameters; the device and its states', async (t) => {
  const ctx = await setup(t);
  const { gladys, sma, store } = ctx;
  assert.deepEqual(sma.routes(), READ);
  // The certificate is checked before every request, the password goes to the token request only.
  assert.ok(sma.connections.every((c) => c.fingerprintChecked));
  const [token, ...reads] = sma.requests;
  assert.match(token.body, /grant_type=password&username=gladys-user&password=S3cret%20pass!/);
  assert.equal(token.contentType, 'application/x-www-form-urlencoded;charset=UTF-8');
  for (const r of reads) {
    assert.equal(r.headers.Authorization, 'Bearer tok-1');
    assert.ok(!r.body.includes(PASSWORD));
  }
  const device = deviceOf(gladys);
  assert.equal(device.external_id, `ext:test-integration:sma:${SERIAL}`);
  assert.equal(device.name, 'SMA EV Charger 7890');
  assert.equal(device.model, 'EVC22-3AC-10');
  assert.ok(device.features.every((f) => f.type !== 'binary' || f.read_only));
  assert.ok(!device.features.some((f) => f.category === 'switch'));
  assert.equal(last(gladys, 'status'), 'Véhicule branché, charge arrêtée');
  assert.equal(last(gladys, 'charging-mode'), 'Arrêt de la charge');
  assert.equal(last(gladys, 'set-mode'), 'stop');
  assert.equal(last(gladys, 'charge-stopped'), 1);
  assert.equal(last(gladys, 'connector-status'), CONNECTOR_STATUS.OCCUPIED);
  assert.equal(last(gladys, 'charging-state'), CHARGING_STATE.PAUSED_BY_CHARGER);
  assert.equal(last(gladys, 'plugged'), 1);
  assert.equal(last(gladys, 'energy-index'), 875.891);
  assert.equal(last(gladys, 'session-energy'), 8.127);
  assert.equal(last(gladys, 'current-limit'), 16);
  assert.equal(last(gladys, 'set-current'), '16');
  assert.equal(last(gladys, 'voltage-l1'), 233.2);
  assert.equal(last(gladys, 'rotary-switch'), 'Charge rapide');
  assert.equal(last(gladys, 'station-status'), 'OK');
  assert.match(
    message(gladys).en,
    /^Connected\. SMA EV Charger 7890: Vehicle plugged in, charge stopped/,
  );
  assert.equal(gladys.fake.transports.at(-1).transport, DEVICE_TRANSPORTS.LOCAL);
  // /data: the pin, the serial, never a secret.
  assert.equal(store.data.pin, FP);
  assert.equal(store.data.serial, SERIAL);
  assertNoSecret(ctx);
});

test('the token is used again until 90 % of its life, renewed once when refused', async (t) => {
  const { sma, advance, app } = await setup(t);
  sma.requests.length = 0;
  await advance(app.interval);
  assert.deepEqual(sma.routes(), READ_AGAIN);
  // The charger restarted: the token is refused, a new one is asked once.
  sma.tokens.clear();
  sma.requests.length = 0;
  await advance(app.interval);
  assert.deepEqual(sma.routes(), [
    'POST /api/v1/measurements/live',
    'POST /api/v1/token',
    'POST /api/v1/measurements/live',
    'POST /api/v1/parameters/search',
  ]);
  // Old (90 % of 3600 s): renewed before the read.
  sma.requests.length = 0;
  await advance(HOUR, 30 * SECOND);
  assert.ok(sma.count('POST /api/v1/token') >= 1);
  assert.ok(sma.count('POST /api/v1/token') <= 2);
});

test('never read sooner than the interval: button, reconnection, unchanged save, restart', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store });
  const { gladys, sma, app, advance } = ctx;
  sma.requests.length = 0;
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /at most once per interval/);
  await app.configUpdated(CONFIG);
  await app.connectedVia(async () => CONFIG);
  await advance(10 * SECOND);
  assert.equal(sma.requests.length, 0);
  await advance(app.interval);
  assert.deepEqual(sma.routes(), READ_AGAIN);
  // A new life (a restart) 5 s later: /data says when the last read was.
  app.halt();
  sma.requests.length = 0;
  const again = await setup(t, { store, sma, clock: ctx.clock });
  await again.advance(5 * SECOND);
  assert.equal(sma.requests.length, 0);
});

test('credentials refused: a block kept in /data, no automatic try, the button or new credentials try again', async (t) => {
  const ctx = await setup(t, { create: false });
  const { gladys, sma, app, advance, store, clock } = ctx;
  sma.password = 'changed';
  sma.tokens.clear();
  await advance(app.interval);
  assert.match(message(gladys).en, /refused the user name or the password: no new try/);
  assert.ok(store.data.block);
  sma.requests.length = 0;
  await advance(2 * HOUR, MINUTE);
  assert.equal(sma.count('POST /api/v1/token'), 0);
  // The button: one try, then at most once a minute.
  let ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /refused the user name/);
  assert.equal(sma.count('POST /api/v1/token'), 1);
  ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /at most once a minute/);
  assert.equal(sma.count('POST /api/v1/token'), 1);
  await clock.advance(MINUTE);
  sma.password = PASSWORD;
  ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /^Connected/);
  assert.equal(store.data.block, null);
  // Refused again, then new credentials: tried at once.
  sma.password = 'right';
  sma.tokens.clear();
  await advance(app.interval);
  assert.ok(store.data.block);
  await app.configUpdated({ ...CONFIG, password: 'right' });
  await settle();
  assert.match(message(gladys).en, /^Connected/);
  assert.equal(store.data.block, null);
  assertNoSecret({ ...ctx, logs: ctx.logs.filter((l) => !l.includes('right')) });
});

test('a read refused with a token just given is not a refused password', async (t) => {
  const { gladys, sma, app, advance, store } = await setup(t);
  sma.hooks['POST /api/v1/parameters/search'] = () => ({ status: 403, body: '' });
  sma.tokens.clear();
  await advance(app.interval);
  assert.match(message(gladys).en, /lack the rights/);
  assert.equal(store.data.block, null);
});

test('429 and 5xx: a pause kept in /data; the stop still goes', async (t) => {
  const { gladys, sma, app, advance, store, press } = await setup(t);
  sma.hooks['POST /api/v1/measurements/live'] = () => ({
    status: 429,
    body: '',
    headers: { 'retry-after': '600' },
  });
  await advance(app.interval);
  assert.match(message(gladys).en, /HTTP 429/);
  assert.ok(store.data.pause.until > 0);
  delete sma.hooks['POST /api/v1/measurements/live'];
  sma.requests.length = 0;
  await advance(5 * MINUTE, 10 * SECOND);
  assert.equal(sma.requests.length, 0);
  sma.state.mode = '4718';
  const ack = await press('stop-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(sma.writes.at(-1), { channelId: 'Parameter.Chrg.ActChaMod', value: '4721' });
});

test('the certificate: pinned at the first connection, another one refused before any byte, trusted in two clicks', async (t) => {
  const ctx = await setup(t);
  const { gladys, sma, app, advance, store, clock } = ctx;
  sma.fingerprint = OTHER_FP;
  sma.requests.length = 0;
  await advance(app.interval);
  assert.equal(sma.requests.length, 0, 'nothing written to another certificate');
  assert.match(message(gladys).en, /certificate of the charger changed/);
  assert.equal(store.data.refusedPin, OTHER_FP);
  const first = await gladys.fake.action(ACTIONS.TRUST_CERTIFICATE);
  assert.match(first.data.message.en, new RegExp(OTHER_FP));
  // Too soon: a first click again.
  const soon = await gladys.fake.action(ACTIONS.TRUST_CERTIFICATE);
  assert.match(soon.data.message.en, /click again/);
  await clock.advance(5 * SECOND);
  const second = await gladys.fake.action(ACTIONS.TRUST_CERTIFICATE);
  assert.match(second.data.message.en, /trusted from now on/);
  assert.equal(store.data.pin, OTHER_FP);
  assert.deepEqual(sma.routes().slice(0, 2), READ_AGAIN);
});

test('/data cannot be written at the first connection: the password is never sent', async (t) => {
  const store = memoryStore();
  store.failSave = true;
  const { sma, gladys } = await setup(t, { store, create: false });
  assert.equal(sma.requests.length, 0);
  assert.match(message(gladys).en, /could not be kept in \/data/);
});

test('/data unreadable is not empty: nothing pinned nor sent until it can be read', async (t) => {
  const store = memoryStore({ pin: OTHER_FP, target: HOST });
  store.failLoad = true;
  const { sma, gladys, app, advance } = await setup(t, { store, create: false });
  assert.equal(sma.connections.length, 0);
  assert.match(message(gladys).en, /cannot be read/);
  store.failLoad = false;
  await advance(app.interval);
  // Read again: the pin of /data refuses the certificate (nothing written).
  assert.equal(sma.requests.length, 0);
  assert.match(message(gladys).en, /certificate of the charger changed/);
});

test('getConfig() failing in `connected` is asked again without end, with its status', async (t) => {
  // The first call is the resynchronization of the fake connect(); then two failures.
  let calls = 0;
  const getConfig = async () => {
    calls += 1;
    if (calls === 2 || calls === 3) {
      throw new Error('unavailable');
    }
    return CONFIG;
  };
  const { gladys, sma, advance } = await setup(t, { getConfig, create: false });
  assert.match(message(gladys).en, /could not be read from Gladys: asked again in 5 s/);
  assert.equal(sma.connections.length, 0);
  await advance(5 * SECOND);
  assert.match(message(gladys).en, /asked again in 15 s/);
  await advance(15 * SECOND);
  assert.match(message(gladys).en, /^Connected/);
});

test('a reconnection whose getConfig() fails keeps the configuration: the stop goes', async (t) => {
  const ctx = await setup(t);
  const { gladys, app, press, sma } = ctx;
  gladys.getConfig = async () => {
    throw new Error('unavailable');
  };
  await app.connectedVia(() => gladys.getConfig());
  assert.match(message(gladys).en, /could not be read from Gladys/);
  sma.state.mode = '4718';
  const ack = await press('stop-charge');
  assert.equal(ack.success, true, ack.error);
  assert.equal(sma.state.mode, '4721');
});

test('the energy index: never 0 nor a drop published, held, accepted in two clicks', async (t) => {
  const { gladys, sma, app, advance, clock } = await setup(t);
  assert.equal(last(gladys, 'energy-index'), 875.891);
  sma.state.meterWh = 0;
  await advance(app.interval);
  assert.equal(last(gladys, 'energy-index'), 875.891);
  sma.state.meterWh = 1_000;
  await advance(app.interval);
  assert.equal(last(gladys, 'energy-index'), 875.891);
  assert.match(message(gladys).en, /held back: a drop/);
  assert.equal(gladys.fake.transports.at(-1).degraded, true);
  const first = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  assert.match(first.data.message.en, /from 875.891 to 1 kWh/);
  await clock.advance(5 * SECOND);
  const second = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  assert.match(second.data.message.en, /Accepted/);
  assert.equal(last(gladys, 'energy-index'), 1);
  sma.state.meterWh = 1_100;
  await advance(app.interval);
  assert.equal(last(gladys, 'energy-index'), 1.1);
});

test('stop: no option needed, written at once, confirmed by a read', async (t) => {
  const { gladys, sma, press } = await setup(t);
  sma.state.mode = '4718';
  sma.state.session = 200113;
  const ack = await press('stop-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(sma.writes, [{ channelId: 'Parameter.Chrg.ActChaMod', value: '4721' }]);
  assert.equal(last(gladys, 'charging-mode'), 'Arrêt de la charge');
});

test('start, mode and current: refused while the option is off', async (t) => {
  const { sma, press } = await setup(t);
  for (const [role, value] of [
    ['start-charge', 1],
    ['set-mode', 'boost'],
    ['set-current', '10'],
  ]) {
    const ack = await press(role, value);
    assert.equal(ack.success, false);
    assert.match(ack.error, /désactivés/);
  }
  assert.equal(sma.writes.length, 0);
  // The mode "stop" of the select is a stop: no option needed.
  sma.state.mode = '4718';
  const ack = await press('set-mode', 'stop');
  assert.equal(ack.success, true, ack.error);
  assert.equal(sma.state.mode, '4721');
});

test('start: needs a vehicle, writes boost charging, one change a minute', async (t) => {
  const { gladys, sma, press, advance, store } = await setup(t, { config: ALLOWED });
  sma.state.session = 200111;
  let ack = await press('start-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Aucun véhicule n'est branché/);
  sma.state.session = 200112;
  ack = await press('start-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(sma.writes, [{ channelId: 'Parameter.Chrg.ActChaMod', value: '4718' }]);
  assert.ok(Number.isFinite(store.data.lastChangeAt));
  ack = await press('set-current', '10');
  assert.equal(ack.success, false);
  assert.match(ack.error, /moins d'une minute/);
  await advance(MINUTE);
  ack = await press('set-current', '10');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(sma.writes.at(-1), { channelId: 'Parameter.Inverter.AcALim', value: '10' });
  assert.equal(last(gladys, 'current-limit'), 10);
});

test('current: capped by the ceiling of the configuration and of the charger', async (t) => {
  const { sma, press, app } = await setup(t, { config: { ...ALLOWED, max_current: 20 } });
  let ack = await press('set-current', '21');
  assert.equal(ack.success, false);
  assert.match(ack.error, /entre 6 et 20 A/);
  sma.state.limitMax = 13;
  ack = await press('set-current', '16');
  assert.equal(ack.success, false);
  assert.match(ack.error, /entre 6 et 13 A/);
  assert.equal(sma.writes.length, 0);
  assert.equal(app.ceiling, 13);
});

test('a start whose save() to /data fails is refused unsent; the stop still goes', async (t) => {
  const { sma, press, store } = await setup(t, { config: ALLOWED });
  store.failSave = true;
  let ack = await press('start-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /\/data/);
  assert.equal(sma.writes.length, 0);
  sma.state.mode = '4718';
  ack = await press('stop-charge');
  assert.equal(ack.success, true, ack.error);
  assert.equal(sma.state.mode, '4721');
});

test('optimized charging not offered by the charger: refused', async (t) => {
  const { sma, press } = await setup(t, { config: ALLOWED });
  const ack = await press('set-mode', 'optimized');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Sunny Home Manager/);
  assert.equal(sma.writes.length, 0);
});

test('a stop arriving while a start reads: the start never leaves, the stop goes', async (t) => {
  const { sma, send, advance } = await setup(t, { config: ALLOWED });
  sma.delay['POST /api/v1/parameters/search'] = 1_000;
  const start = send('start-charge');
  await advance(200, 50);
  const stop = send('stop-charge');
  await advance(5 * SECOND, 50);
  const [a, b] = await Promise.all([start, stop]);
  assert.equal(a.success, false);
  assert.equal(b.success, true, b.error);
  assert.deepEqual(sma.writes, [{ channelId: 'Parameter.Chrg.ActChaMod', value: '4721' }]);
});

test('a stop not sent (charger unreachable) is kept and sent again before the next reads', async (t) => {
  const { gladys, sma, press, advance, app, store } = await setup(t);
  sma.state.mode = '4718';
  sma.down = true;
  const ack = await press('stop-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /gardée et renvoyée/);
  assert.ok(sma.connections.length > 4, 'tried again within its budget');
  assert.equal(store.data.pendingStop.serial, SERIAL);
  assert.match(message(gladys).en, /sent again before the next reads/);
  sma.down = false;
  sma.requests.length = 0;
  await advance(app.interval);
  assert.equal(sma.routes()[0], 'PUT /api/v1/parameters/IGULD:SELF');
  assert.equal(sma.state.mode, '4721');
  assert.equal(store.data.pendingStop, null);
});

test('a stop kept is tried 3 times at most', async (t) => {
  const { sma, press, advance, app, store } = await setup(t);
  sma.down = true;
  await press('stop-charge');
  sma.connections.length = 0;
  await advance(10 * app.interval, 5 * SECOND);
  assert.equal(store.data.pendingStop, null);
  assert.ok(sma.connections.length >= 3);
});

test('a stop contradicted by a read is sent again, twice at most', async (t) => {
  const { sma, press, advance } = await setup(t);
  sma.state.mode = '4718';
  sma.hooks['PUT /api/v1/parameters/IGULD:SELF'] = () => ({ status: 204, body: '' });
  const ack = await press('stop-charge', 1, 30 * SECOND);
  // The read right after the write still shows boost charging: not applied yet.
  assert.equal(ack.success, false);
  assert.match(ack.error, /pas encore appliquée/);
  // The charger never stopped: two more stops at most.
  await advance(2 * MINUTE, 5 * SECOND);
  assert.equal(sma.count('PUT /api/v1/parameters/IGULD:SELF'), 3);
});

test('a stop confirmed, then a start from the SMA app: left alone', async (t) => {
  const { sma, press, advance, app } = await setup(t);
  sma.state.mode = '4718';
  await press('stop-charge', 1, 25 * SECOND);
  assert.equal(sma.state.mode, '4721');
  sma.state.mode = '4718';
  await advance(app.interval);
  assert.equal(sma.count('PUT /api/v1/parameters/IGULD:SELF'), 1);
});

test('a start sent without confirmation, then a stop: the stop is sent again when a read shows the start', async (t) => {
  const { sma, press, advance } = await setup(t, { config: ALLOWED });
  sma.hooks['PUT /api/v1/parameters/IGULD:SELF'] = () => 'timeout';
  const ack = await press('start-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /envoyée, sans confirmation/);
  delete sma.hooks['PUT /api/v1/parameters/IGULD:SELF'];
  const stop = await press('stop-charge');
  assert.equal(stop.success, true, stop.error);
  // The late start lands after the stop.
  sma.state.mode = '4718';
  await advance(30 * SECOND);
  assert.equal(sma.state.mode, '4721');
  assert.ok(sma.count('PUT /api/v1/parameters/IGULD:SELF') >= 3);
});

test('a stop before the first read after a restart goes to the serial kept in /data', async (t) => {
  const store = memoryStore();
  const first = await setup(t, { store });
  first.app.halt();
  first.sma.down = true;
  const devices = first.gladys.fake.devices;
  const again = await setup(t, { store, sma: first.sma, clock: first.clock, devices });
  again.sma.down = false;
  again.sma.state.mode = '4718';
  const ack = await again.press('stop-charge');
  assert.equal(ack.success, true, ack.error);
  assert.equal(again.sma.state.mode, '4721');
});

test('during a block, the stop tries one login every 5 minutes', async (t) => {
  const { sma, press, advance, app } = await setup(t);
  sma.password = 'changed';
  sma.tokens.clear();
  await advance(app.interval);
  sma.requests.length = 0;
  let ack = await press('stop-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /moins de 5 minutes/);
  assert.equal(sma.requests.length, 0);
  await advance(5 * MINUTE, 10 * SECOND);
  sma.password = PASSWORD;
  ack = await press('stop-charge');
  assert.equal(ack.success, true, ack.error);
});

test('a wall clock set forward or back by hours changes no decision', async (t) => {
  let shift = 0;
  const { testClock } = await import('./kit/index.mjs');
  const base = testClock({ start: Date.UTC(2026, 9, 28) });
  const clock = { ...base, now: () => base.now() + shift, advance: (ms) => base.advance(ms) };
  const { sma, app, advance } = await setup(t, { clock });
  sma.requests.length = 0;
  shift = 6 * HOUR;
  await advance(10 * SECOND);
  assert.equal(sma.requests.length, 0);
  shift = -6 * HOUR;
  await advance(app.interval);
  assert.deepEqual(sma.routes(), READ_AGAIN);
});

test('configurations saved in a row apply one after the other, the last one wins', async (t) => {
  const { app } = await setup(t);
  const a = app.configUpdated({ ...CONFIG, max_current: 10 });
  const b = app.configUpdated({ ...CONFIG, max_current: 12 });
  await Promise.all([a, b]);
  assert.equal(app.config.maxCurrent, 12);
});

test('a reconnection republishes the device and the status, never old values as new', async (t) => {
  const { gladys, app, clock } = await setup(t);
  const before = gladys.fake.states.length;
  await clock.advance(1_000);
  await app.connectedVia(async () => CONFIG);
  assert.equal(gladys.fake.states.length, before);
  assert.match(message(gladys).en, /^Connected/);
});

test('a feature unknown or read only refuses the command', async (t) => {
  const { gladys, sma } = await setup(t, { config: ALLOWED });
  const device = gladys.fake.devices[0];
  const ack = await gladys.fake.setValue(
    device,
    device.features.find((f) => f.external_id === feature('power')),
    1,
  );
  assert.equal(ack.success, false);
  assert.equal(sma.writes.length, 0);
});

test('a stop takes the charger from a read that hangs: the read is dropped, not a failure', async (t) => {
  const { gladys, sma, app, advance, send } = await setup(t);
  sma.state.mode = '4718';
  sma.delay['POST /api/v1/measurements/live'] = 60 * SECOND;
  await advance(app.interval, 100);
  assert.ok(app.session, 'a read hangs');
  const ack = send('stop-charge');
  await advance(5 * SECOND, 50);
  const result = await ack;
  assert.equal(result.success, true, result.error);
  assert.equal(sma.state.mode, '4721');
  assert.doesNotMatch(message(gladys).en, /No answer|error/);
});

test('a stop without a token in memory logs in first, then writes', async (t) => {
  const { sma, app, press } = await setup(t);
  app.token = undefined;
  sma.tokens.clear();
  sma.requests.length = 0;
  sma.state.mode = '4718';
  const ack = await press('stop-charge');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(sma.routes().slice(0, 2), [
    'POST /api/v1/token',
    'PUT /api/v1/parameters/IGULD:SELF',
  ]);
});

test('a stop kept is cancelled by a start that left since', async (t) => {
  const { sma, press, advance, app, store } = await setup(t, { config: ALLOWED });
  sma.down = true;
  await press('stop-charge');
  assert.ok(store.data.pendingStop);
  sma.down = false;
  // The start goes (a minute later is not needed: the stop spent no minute).
  const ack = await press('start-charge');
  assert.equal(ack.success, true, ack.error);
  assert.equal(store.data.pendingStop, null);
  sma.requests.length = 0;
  await advance(app.interval);
  assert.equal(sma.count('PUT /api/v1/parameters/IGULD:SELF'), 0);
  assert.equal(sma.state.mode, '4718');
});

test('the watch of a stop survives a restart within its 90 s', async (t) => {
  const store = memoryStore();
  const first = await setup(t, { store });
  first.sma.state.mode = '4718';
  first.sma.hooks['PUT /api/v1/parameters/IGULD:SELF'] = () => ({ status: 204, body: '' });
  await first.press('stop-charge', 1, 2 * SECOND);
  assert.ok(store.data.stopWatch);
  first.app.halt();
  const devices = first.gladys.fake.devices;
  delete first.sma.hooks['PUT /api/v1/parameters/IGULD:SELF'];
  const again = await setup(t, { store, sma: first.sma, clock: first.clock, devices });
  await again.advance(again.app.interval);
  assert.equal(again.sma.state.mode, '4721');
});

test('a start accepted but not applied: "not applied yet", then the guard and the reads', async (t) => {
  const { sma, press, store } = await setup(t, { config: ALLOWED });
  sma.hooks['PUT /api/v1/parameters/IGULD:SELF'] = () => ({ status: 204, body: '' });
  const ack = await press('start-charge', 1, 30 * SECOND);
  assert.equal(ack.success, false);
  assert.match(ack.error, /pas encore appliquée/);
  assert.ok(sma.count('POST /api/v1/parameters/search') >= 4, 'reads 5 s and 20 s after');
  assert.ok(Number.isFinite(store.data.lastChangeAt));
});

test('a start sent without an answer: "sent, without confirmation", watched in /data', async (t) => {
  const { sma, press, store } = await setup(t, { config: ALLOWED });
  sma.hooks['PUT /api/v1/parameters/IGULD:SELF'] = () => 'timeout';
  const ack = await press('start-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /envoyée, sans confirmation/);
  assert.ok(store.data.unconfirmedStartUntil > 0);
});

test('a charger refusing the write (403): refused, the minute given back', async (t) => {
  const { sma, press, store } = await setup(t, { config: ALLOWED });
  sma.hooks['PUT /api/v1/parameters/IGULD:SELF'] = () => ({ status: 403, body: '' });
  sma.tokens.clear();
  const ack = await press('start-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /droits/);
  assert.equal(store.data.lastChangeAt, null);
});

test('a device created long after the last read gets no old value', async (t) => {
  const { gladys, sma, app, advance } = await setup(t, { create: false });
  sma.down = true;
  await advance(10 * app.interval, 10 * SECOND);
  const before = gladys.fake.states.length;
  await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
  await settle();
  const after = gladys.fake.states
    .slice(before)
    .map((s) => s.device_feature_external_id.split(':').at(-1));
  assert.ok(!after.includes('power'));
  assert.ok(!after.includes('energy-index'));
});

test('an energy jump is held, never counted without the user', async (t) => {
  const { gladys, sma, app, advance } = await setup(t);
  sma.state.meterWh += 500_000;
  await advance(app.interval);
  assert.equal(last(gladys, 'energy-index'), 875.891);
  assert.match(message(gladys).en, /held back: a jump/);
  // Back to the usual rule: the hold ends.
  sma.state.meterWh = 875_900;
  await advance(app.interval);
  assert.equal(last(gladys, 'energy-index'), 875.9);
});

test('a command never leaks the password nor the token', async (t) => {
  const ctx = await setup(t, { config: ALLOWED });
  await ctx.press('start-charge');
  await ctx.press('stop-charge');
  assertNoSecret(ctx);
});

test('the option turned off while a start reads: checked again right before sending', async (t) => {
  const { sma, send, advance, app } = await setup(t, { config: ALLOWED });
  sma.delay['POST /api/v1/parameters/search'] = 1_000;
  const ack = send('start-charge');
  await advance(300, 50);
  await app.configUpdated(CONFIG);
  await advance(5 * SECOND, 50);
  const result = await ack;
  assert.equal(result.success, false);
  assert.match(result.error, /désactivés/);
  assert.equal(sma.writes.length, 0);
});

test('a stop kept is dropped when a start left after it', async (t) => {
  const { sma, app } = await setup(t);
  const mono = app.mono();
  app.memory.pendingStop = { serial: SERIAL, at: mono - 1_000, tries: 0 };
  app.charger.lastStartAt = mono - 500;
  sma.requests.length = 0;
  await app.sendPendingStop(app.generation);
  assert.equal(app.memory.pendingStop, null);
  assert.equal(sma.count('PUT /api/v1/parameters/IGULD:SELF'), 0);
});

test('a command that is no longer the one in flight gives way to the stop', async (t) => {
  const { app } = await setup(t);
  const entry = { isStop: false };
  app.inFlight = { isStop: true };
  assert.equal(app.stopArrived(entry), true);
  app.inFlight = entry;
  assert.equal(app.stopArrived(entry), false);
  assert.equal(app.stopArrived({ isStop: true }), false);
  app.inFlight = undefined;
});

test('with refused credentials, no tick reads the charger by itself', async (t) => {
  const { sma, app, advance } = await setup(t);
  sma.password = 'changed';
  sma.tokens.clear();
  await advance(app.interval);
  sma.requests.length = 0;
  await advance(app.interval);
  await app.tick();
  assert.equal(sma.requests.length, 0);
});

test('a 403 with a token just given asks no second token', async (t) => {
  const { sma, app, advance } = await setup(t);
  sma.hooks['POST /api/v1/measurements/live'] = () => ({ status: 403, body: '' });
  sma.tokens.clear();
  app.token = undefined;
  sma.requests.length = 0;
  await advance(app.interval);
  assert.equal(sma.count('POST /api/v1/token'), 1);
});

test('a read begun before a write left is not applied', async (t) => {
  const { gladys, sma, app, advance } = await setup(t);
  sma.delay['POST /api/v1/parameters/search'] = 2 * SECOND;
  sma.state.power = 4321;
  await advance(app.interval, 100);
  // A write leaves while the read is under way.
  app.charger.lastSentAt = app.mono();
  await advance(3 * SECOND, 100);
  assert.notEqual(last(gladys, 'power'), 4321);
});

test('a device created long after the last read (a 429 pause) gets no old value', async (t) => {
  const { gladys, sma, app, advance } = await setup(t, { create: false });
  sma.hooks['POST /api/v1/measurements/live'] = () => ({
    status: 429,
    body: '',
    headers: { 'retry-after': '7200' },
  });
  await advance(app.interval);
  await advance(HOUR, MINUTE);
  const before = gladys.fake.states.length;
  await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
  await settle();
  const roles = gladys.fake.states
    .slice(before)
    .map((s) => s.device_feature_external_id.split(':').at(-1));
  assert.ok(!roles.includes('power'), roles.join());
});

test('the energy guard does not follow a wall clock moved forward', async (t) => {
  let shift = 0;
  const { testClock } = await import('./kit/index.mjs');
  const base = testClock({ start: Date.UTC(2026, 9, 28) });
  const clock = { ...base, now: () => base.now() + shift, advance: (ms) => base.advance(ms) };
  const { gladys, sma, app, advance } = await setup(t, { clock });
  shift = 10 * HOUR;
  sma.state.meterWh += 100_000;
  await advance(app.interval);
  assert.equal(last(gladys, 'energy-index'), 875.891);
});
