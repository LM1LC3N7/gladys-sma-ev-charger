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

test('a stop not sent (charger unreachable) is kept and sent again on its own rhythm', async (t) => {
  const { gladys, sma, press, advance, store } = await setup(t);
  sma.state.mode = '4718';
  sma.down = true;
  const ack = await press('stop-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /gardée et renvoyée toutes les 30 secondes/);
  assert.ok(sma.connections.length > 4, 'tried again within its budget');
  assert.equal(store.data.pendingStop.serial, SERIAL);
  assert.match(message(gladys).en, /^No answer.*not applied yet: it is kept/);
  sma.down = false;
  sma.requests.length = 0;
  await advance(30 * SECOND);
  assert.equal(sma.routes()[0], 'PUT /api/v1/parameters/IGULD:SELF');
  assert.equal(sma.state.mode, '4721');
  assert.equal(store.data.pendingStop, null);
});

test('a stop kept is never dropped by the time, whatever the interval', async (t) => {
  const { sma, press, advance, store } = await setup(t, {
    config: { ...CONFIG, poll_interval: 3600 },
  });
  sma.state.mode = '4718';
  sma.down = true;
  await press('stop-charge');
  await advance(3 * HOUR, MINUTE);
  assert.equal(store.data.pendingStop.serial, SERIAL, 'still kept');
  assert.equal(sma.writes.length, 0);
  sma.down = false;
  // Its own rhythm (30 s), not the interval (1 h).
  await advance(MINUTE, 5 * SECOND);
  assert.equal(sma.state.mode, '4721');
  assert.equal(store.data.pendingStop, null);
});

test('a stop kept is ended by a read showing it stopped, never by another mode read', async (t) => {
  const { app } = await setup(t);
  app.memory.pendingStop = {
    serial: SERIAL,
    at: app.mono(),
    from: '4719',
    changedReads: 0,
    notBefore: Infinity,
    sent: 0,
    rights: false,
    refusal: null,
  };
  for (let i = 0; i < 3; i += 1) app.watchPendingStop({ mode: '4718' });
  assert.ok(app.memory.pendingStop, 'a reboot into another mode is no start from elsewhere');
  app.watchPendingStop({ mode: '4721' });
  assert.equal(app.memory.pendingStop, null, 'shown stopped: done');
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

test('during a block, a stop is kept and goes with the new credentials', async (t) => {
  const { sma, press, advance, app, store } = await setup(t);
  sma.password = 'changed';
  sma.tokens.clear();
  sma.state.mode = '4718';
  await advance(app.interval);
  sma.requests.length = 0;
  // Within a minute of the refusal: no login, kept.
  let ack = await press('stop-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /gardée et part dès que/);
  assert.equal(sma.requests.length, 0);
  assert.equal(store.data.pendingStop.serial, SERIAL);
  // No automatic try with the refused credentials.
  await advance(10 * MINUTE, 10 * SECOND);
  assert.equal(sma.requests.length, 0);
  // A click a minute later logs in (as the button does): refused again, still kept.
  ack = await press('stop-charge');
  assert.match(ack.error, /gardée et part dès que/);
  assert.equal(sma.count('POST /api/v1/token'), 1);
  assert.ok(store.data.pendingStop);
  // New credentials: the stop goes first.
  sma.password = 'new one';
  sma.requests.length = 0;
  await app.configUpdated({ ...CONFIG, password: 'new one' });
  await advance(5 * SECOND);
  assert.equal(sma.routes()[1], 'PUT /api/v1/parameters/IGULD:SELF');
  assert.equal(sma.state.mode, '4721');
  assert.equal(store.data.pendingStop, null);
});

test('during a block, the button that succeeds sends the stop kept at once', async (t) => {
  const { gladys, sma, press, advance, app, store, clock } = await setup(t);
  sma.password = 'changed';
  sma.tokens.clear();
  sma.state.mode = '4718';
  await advance(app.interval);
  await press('stop-charge');
  assert.ok(store.data.pendingStop);
  await clock.advance(MINUTE);
  sma.password = PASSWORD;
  await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  await advance(2 * SECOND, 100);
  assert.equal(sma.state.mode, '4721');
  assert.equal(store.data.pendingStop, null);
});

test('a stop whose write gets a 429 is kept and sent after the wait asked', async (t) => {
  const { sma, press, advance, store } = await setup(t);
  sma.state.mode = '4718';
  let refusals = 1;
  sma.hooks['PUT /api/v1/parameters/IGULD:SELF'] = () =>
    refusals-- > 0 ? { status: 429, body: '', headers: { 'retry-after': '120' } } : undefined;
  const ack = await press('stop-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /gardée/);
  assert.ok(store.data.pendingStop);
  await advance(MINUTE, 5 * SECOND);
  assert.equal(sma.state.mode, '4718', 'waits for the Retry-After');
  await advance(2 * MINUTE, 5 * SECOND);
  assert.equal(sma.state.mode, '4721');
  assert.equal(store.data.pendingStop, null);
});

test('a stop read back stopped, then a start from the SMA app 2 s later: left alone', async (t) => {
  const { sma, press, advance } = await setup(t);
  sma.state.mode = '4718';
  const ack = await press('stop-charge', 1, 2 * SECOND);
  assert.equal(ack.success, true, ack.error);
  sma.state.mode = '4718';
  await advance(30 * SECOND);
  assert.equal(sma.count('PUT /api/v1/parameters/IGULD:SELF'), 1);
  assert.equal(sma.state.mode, '4718');
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
  const failures = app.memory.block.failures;
  await advance(app.interval);
  await app.tick();
  assert.equal(sma.requests.length, 0);
  assert.equal(app.memory.block.failures, failures, 'no try counted either');
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

// --- Review r1, I3: one test per guard -------------------------------------------

/** A store whose saves take `delay` ms on the test clock. */
function slowStore(clock, delay) {
  const store = memoryStore();
  const save = store.save.bind(store);
  store.save = (data) =>
    store.slow
      ? new Promise((resolve) => clock.timers.setTimeout(resolve, delay)).then(() => save(data))
      : save(data);
  return store;
}

test('a stop kept goes during a 429 pause of the reads', async (t) => {
  const { sma, app, advance, store } = await setup(t);
  sma.state.mode = '4718';
  app.memory.pause = { until: app.mono() + 6 * HOUR, reason: '429' };
  app.keepStop(SERIAL, undefined);
  await advance(MINUTE, 5 * SECOND);
  assert.equal(sma.state.mode, '4721');
  assert.equal(store.data.pendingStop, null);
});

test('the read of a command never sends a stop again', async (t) => {
  const { sma, press, advance } = await setup(t, { config: ALLOWED });
  sma.state.mode = '4718';
  sma.hooks['PUT /api/v1/parameters/IGULD:SELF'] = () => ({ status: 204, body: '' });
  await press('stop-charge', 1, 1 * SECOND);
  delete sma.hooks['PUT /api/v1/parameters/IGULD:SELF'];
  const puts = () =>
    sma.requests.filter((r) => r.method === 'PUT').map((r) => JSON.parse(r.body).values[0].value);
  assert.deepEqual(puts(), ['4721']);
  // The fresh read of the current command shows boost charging: not a reason to stop again.
  await press('set-current', '10', 1 * SECOND);
  assert.deepEqual(puts(), ['4721', '10']);
  await advance(SECOND);
});

test('a stop sent again marks the time a write left (older reads quarantined)', async (t) => {
  const { app, advance } = await setup(t);
  const before = app.charger.lastSentAt;
  app.reassertStop(SERIAL);
  await advance(SECOND, 100);
  assert.ok(app.charger.lastSentAt > before);
});

test('a read begun before a write left is never applied (fresh read of a command)', async (t) => {
  const { app } = await setup(t);
  const readStart = app.mono();
  app.charger.lastSentAt = app.mono();
  const measures = { ...app.charger.measures, power: 9999 };
  app.applyFresh({ measures, control: app.charger.control }, readStart);
  assert.notEqual(app.charger.measures.power, 9999);
});

test('before the first read after a restart, a stop for another serial is refused', async (t) => {
  const store = memoryStore();
  const first = await setup(t, { store });
  first.app.halt();
  first.sma.down = true;
  const own = first.gladys.fake.devices[0];
  const other = JSON.parse(JSON.stringify(own).replaceAll(SERIAL, '9999999999'));
  const again = await setup(t, {
    store,
    sma: first.sma,
    clock: first.clock,
    devices: [own, other],
  });
  first.sma.connections.length = 0;
  await assert.rejects(
    again.app.setValue(
      other,
      other.features.find((f) => f.external_id.endsWith(':stop-charge')),
      1,
    ),
    /n'est pas lue/,
  );
  assert.equal(first.sma.connections.length, 0);
});

test('a current above the ceiling known is refused without a request; above 32 A, the bound says 32', async (t) => {
  const { sma, press } = await setup(t, { config: ALLOWED });
  sma.requests.length = 0;
  let ack = await press('set-current', '20');
  assert.match(ack.error, /entre 6 et 16 A/);
  assert.equal(sma.requests.length, 0);
  ack = await press('set-current', '40');
  assert.match(ack.error, /entre 6 et 32 A/);
});

test('a command whose reads and save end after 3.5 s is never written', async (t) => {
  const clock = (await import('./kit/index.mjs')).testClock({ start: Date.UTC(2026, 9, 28) });
  const store = slowStore(clock, 600);
  const { sma, press } = await setup(t, { config: ALLOWED, clock, store });
  sma.delay['POST /api/v1/parameters/search'] = 3_000;
  store.slow = true;
  const ack = await press('start-charge');
  assert.equal(ack.success, false);
  assert.match(ack.error, /trop lentement/);
  assert.equal(sma.writes.length, 0);
});

test('a ceiling lowered while a current command waits: refused right before sending', async (t) => {
  const clock = (await import('./kit/index.mjs')).testClock({ start: Date.UTC(2026, 9, 28) });
  const store = slowStore(clock, 500);
  const { sma, send, advance, app } = await setup(t, { config: ALLOWED, clock, store });
  store.slow = true;
  const ack = send('set-current', '12');
  await advance(200, 50);
  await app.configUpdated({ ...ALLOWED, max_current: 8 });
  await advance(5 * SECOND, 50);
  const result = await ack;
  assert.equal(result.success, false);
  assert.match(result.error, /entre 6 et 8 A/);
  assert.equal(sma.writes.length, 0);
});

test('the rated current of the charger caps the current; under 6 A nothing is sent', async (t) => {
  const { sma, press } = await setup(t, { config: { ...ALLOWED, max_current: 32 } });
  sma.state.rated = '10.000';
  let ack = await press('set-current', '12');
  assert.match(ack.error, /entre 6 et 10 A/);
  sma.state.limitMax = 5;
  ack = await press('set-current', '6');
  assert.match(ack.error, /sous les 6 A/);
  ack = await press('start-charge');
  assert.match(ack.error, /sous les 6 A/);
  assert.equal(sma.writes.length, 0);
});

test('a mode on a charger in fault or locked is refused', async (t) => {
  const { sma, press } = await setup(t, { config: ALLOWED });
  sma.state.session = 200115;
  let ack = await press('set-mode', 'boost');
  assert.match(ack.error, /Défaut de la borne/);
  sma.state.session = 5169;
  ack = await press('set-mode', 'boost');
  assert.match(ack.error, /verrouillée/);
  assert.equal(sma.writes.length, 0);
});

test('a command during a 429 pause reads nothing', async (t) => {
  const { sma, press, app } = await setup(t, { config: ALLOWED });
  app.memory.pause = { until: app.mono() + HOUR, reason: '429' };
  sma.requests.length = 0;
  const ack = await press('start-charge');
  assert.match(ack.error, /ralentir/);
  assert.equal(sma.requests.length, 0);
});

test('two clicks of "Accept the held index" less than 3 s apart accept nothing', async (t) => {
  const { gladys, sma, app, advance, clock } = await setup(t);
  sma.state.meterWh = 1_000;
  await advance(app.interval);
  await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  await clock.advance(1_000);
  const second = await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  assert.match(second.data.message.en, /Click again/);
  assert.equal(last(gladys, 'energy-index'), 875.891);
});

test('"Trust the new certificate" never pins a fingerprint that was not shown', async (t) => {
  const { gladys, sma, app, advance, store, clock } = await setup(t);
  sma.fingerprint = OTHER_FP;
  await advance(app.interval);
  await gladys.fake.action(ACTIONS.TRUST_CERTIFICATE);
  // Another certificate seen meanwhile.
  const third = FP.replace(/^../, 'EE');
  sma.fingerprint = third;
  await advance(app.interval);
  assert.equal(store.data.refusedPin, third);
  await clock.advance(5 * SECOND);
  const second = await gladys.fake.action(ACTIONS.TRUST_CERTIFICATE);
  assert.match(second.data.message.en, /click again/);
  assert.equal(store.data.pin, FP);
});

test('a 403 from the token endpoint without an OAuth error is not a refusal', async (t) => {
  const { gladys, sma, app, advance, store } = await setup(t);
  sma.tokens.clear();
  app.token = undefined;
  sma.hooks['POST /api/v1/token'] = () => ({ status: 403, body: '<html>busy</html>' });
  await advance(app.interval);
  assert.equal(store.data.block, null);
  assert.doesNotMatch(message(gladys).en, /refused the user name/);
  sma.hooks['POST /api/v1/token'] = () => ({ status: 400, body: '{"error":"invalid_grant"}' });
  await advance(5 * MINUTE, 10 * SECOND);
  assert.ok(store.data.block);
});

test('401/403 on the reads with a token just given: the wait doubles up to 1 h', async (t) => {
  const { sma, app, advance } = await setup(t);
  sma.hooks['POST /api/v1/measurements/live'] = () => ({ status: 403, body: '' });
  sma.tokens.clear();
  app.token = undefined;
  sma.requests.length = 0;
  await advance(2 * HOUR, MINUTE);
  // 5, 10, 20, 40 min, then 1 h: at most 6 logins in 2 h.
  assert.ok(sma.count('POST /api/v1/token') <= 6, String(sma.count('POST /api/v1/token')));
});

test('an accepted drop is a floor: a lower value later is held again', async (t) => {
  const { gladys, sma, app, advance, clock } = await setup(t);
  sma.state.meterWh = 12_000;
  await advance(app.interval);
  await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  await clock.advance(4 * SECOND);
  await gladys.fake.action(ACTIONS.ACCEPT_HELD);
  assert.equal(last(gladys, 'energy-index'), 12);
  sma.state.meterWh = 5_000;
  await advance(app.interval);
  assert.ok(
    !gladys.fake.states.some(
      (s) => s.device_feature_external_id === feature('energy-index') && s.state === 5,
    ),
    'never 5 kWh without a click',
  );
  assert.equal(app.currentHold().to, 5);
  // The value accepted comes back: it follows, from the floor accepted.
  sma.state.meterWh = 12_100;
  await advance(app.interval);
  assert.equal(last(gladys, 'energy-index'), 12.1);
  assert.equal(app.currentHold(), undefined);
});

// --- Review r2 ----------------------------------------------------------------------

/** The PUT answered `status` the next `n` times, then normally. */
const refuseWrites = (sma, status, n = 1) => {
  sma.hooks['PUT /api/v1/parameters/IGULD:SELF'] = () =>
    n-- > 0 ? { status, body: '' } : undefined;
};

test('a stop kept answered 409 once is kept and sent again 5 minutes later', async (t) => {
  const { gladys, sma, press, advance, store, app } = await setup(t);
  sma.state.mode = '4718';
  await advance(app.interval);
  sma.down = true;
  await press('stop-charge');
  refuseWrites(sma, 409);
  sma.down = false;
  await advance(MINUTE, 5 * SECOND);
  assert.equal(sma.state.mode, '4718');
  assert.deepEqual(store.data.pendingStop.refusal, { status: 409, count: 1 });
  assert.match(message(gladys).en, /refused by the charger \(HTTP 409\): it is kept/);
  await advance(5 * MINUTE, 10 * SECOND);
  assert.equal(sma.state.mode, '4721');
  assert.equal(store.data.pendingStop, null);
});

test('a clicked stop answered 400 is kept; given up after 3 identical refusals, said until a click', async (t) => {
  const { gladys, sma, press, advance, store, app } = await setup(t);
  sma.state.mode = '4718';
  await advance(app.interval);
  refuseWrites(sma, 400, 3);
  const ack = await press('stop-charge');
  assert.match(ack.error, /gardée et renvoyée toutes les 5 minutes/);
  assert.ok(store.data.pendingStop);
  await advance(11 * MINUTE, 10 * SECOND);
  assert.equal(store.data.pendingStop, null);
  assert.deepEqual(store.data.stopGivenUp, { serial: SERIAL, status: 400 });
  assert.match(message(gladys).en, /refused 3 times in a row \(HTTP 400\) and given up/);
  assert.equal(gladys.fake.transports.at(-1).degraded, true);
  // Still said at the next reads, until a click.
  await advance(2 * MINUTE, 10 * SECOND);
  assert.match(message(gladys).en, /given up/);
  const again = await press('stop-charge');
  assert.equal(again.success, true, again.error);
  assert.equal(store.data.stopGivenUp, null);
  assert.doesNotMatch(message(gladys).en, /given up/);
});

test('a stop refused for the rights (403 with a token just given) waits for the button or other credentials', async (t) => {
  const { gladys, sma, press, advance, store, app, clock } = await setup(t);
  sma.state.mode = '4718';
  await advance(app.interval);
  refuseWrites(sma, 403, 2);
  const ack = await press('stop-charge');
  assert.match(ack.error, /n'a peut-être pas les droits. Elle est gardée/);
  assert.equal(store.data.pendingStop.rights, true);
  const puts = sma.count('PUT /api/v1/parameters/IGULD:SELF');
  await advance(10 * MINUTE, 10 * SECOND);
  assert.equal(sma.count('PUT /api/v1/parameters/IGULD:SELF'), puts, 'no automatic try');
  assert.match(message(gladys).en, /refused for the rights/);
  await clock.advance(app.interval);
  await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  await advance(2 * SECOND, 100);
  assert.equal(sma.state.mode, '4721');
  assert.equal(store.data.pendingStop, null);
});

test('under a live guard, a mode equal to the one read is still written (never "already so")', async (t) => {
  const { sma, press, advance } = await setup(t, { config: ALLOWED });
  sma.state.possibleModes = ['4718', '4719', '4721'];
  sma.hooks['PUT /api/v1/parameters/IGULD:SELF'] = (r) =>
    JSON.parse(r.body).values[0].value === '4718' ? { status: 204, body: '' } : undefined;
  await press('start-charge');
  await advance(61 * SECOND);
  sma.state.mode = '4719';
  const before = sma.requests.filter((r) => r.method === 'PUT').length;
  await press('set-mode', 'optimized');
  assert.equal(sma.requests.filter((r) => r.method === 'PUT').length, before + 1);
});

test('a poll read showing 4721 ends a stop kept; other modes never do', async (t) => {
  const { sma, app, advance, store } = await setup(t);
  const keep = (from) => {
    app.memory.pendingStop = {
      serial: SERIAL,
      at: app.mono(),
      from,
      changedReads: 0,
      notBefore: app.mono() + HOUR,
      sent: 0,
      rights: false,
      refusal: null,
    };
  };
  keep('4718');
  sma.state.mode = '4721';
  await advance(app.interval);
  assert.equal(store.data.pendingStop, null);
  keep('4721');
  sma.state.mode = '4718';
  await advance(3 * app.interval);
  assert.ok(store.data.pendingStop);
});

test('a start that leaves clears the stop kept in /data at once', async (t) => {
  const { sma, press, store } = await setup(t, { config: ALLOWED });
  sma.down = true;
  await press('stop-charge');
  sma.down = false;
  sma.state.mode = '4721';
  // The start goes before the stop timer (the kept stop waits 30 s).
  const ack = await press('start-charge', 1, 2 * SECOND);
  assert.equal(ack.success, true, ack.error);
  assert.equal(store.data.pendingStop, null);
});

test('a clicked stop applied clears the stop kept before it', async (t) => {
  const { sma, press, store, app } = await setup(t);
  app.memory.pendingStop = {
    serial: SERIAL,
    at: app.mono(),
    from: null,
    changedReads: 0,
    notBefore: app.mono() + HOUR,
    sent: 0,
    rights: false,
    refusal: null,
  };
  sma.state.mode = '4718';
  const ack = await press('stop-charge', 1, 2 * SECOND);
  assert.equal(ack.success, true, ack.error);
  assert.equal(store.data.pendingStop, null);
});

test('a good read resets the doubling wait of the reads refused for rights', async (t) => {
  const { sma, app, advance } = await setup(t);
  sma.hooks['POST /api/v1/measurements/live'] = () => ({ status: 403, body: '' });
  sma.tokens.clear();
  app.token = undefined;
  await advance(app.interval);
  assert.equal(app.charger.forbidden, 1);
  delete sma.hooks['POST /api/v1/measurements/live'];
  await advance(5 * MINUTE, 10 * SECOND);
  assert.equal(app.charger.forbidden, 0);
});

test('the stop timer is armed at a start with a stop kept, and again after each try', async (t) => {
  const store = memoryStore();
  const first = await setup(t, { store, config: { ...CONFIG, poll_interval: 3600 } });
  first.sma.state.mode = '4718';
  first.sma.down = true;
  await first.press('stop-charge');
  first.app.halt();
  const devices = first.gladys.fake.devices;
  const again = await setup(t, {
    store,
    sma: first.sma,
    clock: first.clock,
    devices,
    config: { ...CONFIG, poll_interval: 3600 },
  });
  // Still down at the restart: the first read and the first tries fail.
  await again.advance(2 * MINUTE, 5 * SECOND);
  again.sma.down = false;
  await again.advance(MINUTE, 5 * SECOND);
  assert.equal(again.sma.state.mode, '4721');
});

test('the stop timer is armed again after a try that could not run', async (t) => {
  const { sma, app, advance, store } = await setup(t, {
    config: { ...CONFIG, poll_interval: 3600 },
  });
  sma.state.mode = '4718';
  app.memory.pendingStop = {
    serial: SERIAL,
    at: app.mono(),
    from: null,
    changedReads: 0,
    notBefore: -Infinity,
    sent: 0,
    rights: false,
    refusal: null,
  };
  // Another stop holds the charger when the timer fires: this try does nothing.
  app.session = { kind: 'stop', aborted: false, done: Promise.resolve() };
  app.armStopTimer(0);
  await advance(SECOND, 100);
  app.session = undefined;
  await advance(MINUTE, 5 * SECOND);
  assert.equal(sma.state.mode, '4721');
  assert.equal(store.data.pendingStop, null);
});
