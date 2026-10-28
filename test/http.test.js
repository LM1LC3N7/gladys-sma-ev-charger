// -----------------------------------------------------------------------------
// The real transport (src/sma/http.js) and the real client against real TLS
// servers on the loopback (the testkit's device certificate, an impostor, a
// refused port): the certificate checked BEFORE any byte is written (the
// password included), no byte of an impostor read, one connection per
// request, the bounds of the answers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SmaClient } from '../src/sma/client.js';
import {
  AnswerParser,
  ChargerError,
  ERROR_KINDS,
  exchange,
  normalizeFingerprint,
} from '../src/sma/http.js';
import { certs, httpsServer, impostorServer, refusePort, reply } from './kit/index.mjs';
import { measurementsOf, parametersOf } from './helpers/fakeSma.js';

const PIN = normalizeFingerprint(certs.device.fingerprint256);
const pinned =
  (expected = PIN) =>
  async (fingerprint) => {
    if (fingerprint !== expected) {
      throw new ChargerError(ERROR_KINDS.CERTIFICATE, 'changed', { notSent: true, fingerprint });
    }
  };
const STATE = {
  serial: '1234567890',
  session: 200113,
  health: 307,
  rotary: 4950,
  power: 7200,
  currents: [10.1, 10.2, 10.3],
  voltages: [230, 231, 232],
  meterWh: 123_456,
  sessionWh: 4200,
  mode: '4718',
  possibleModes: ['4718', '4719', '4721'],
  limit: '16.000',
  limitMin: 6,
  limitMax: 32,
  rated: '32.000',
};

async function smaServer(t, extra = {}) {
  const srv = await httpsServer({
    routes: {
      'POST /api/v1/token': (r) =>
        new URLSearchParams(r.body).get('password') === 'pass word&='
          ? { access_token: 'tok-1', refresh_token: 'r', expires_in: 3600 }
          : reply(401, { error: 'invalid_grant' }),
      'POST /api/v1/measurements/live': (r) =>
        r.headers.authorization === 'Bearer tok-1' ? measurementsOf(STATE) : reply(401, ''),
      'POST /api/v1/parameters/search': (r) =>
        r.headers.authorization === 'Bearer tok-1' ? parametersOf(STATE) : reply(401, ''),
      'PUT /api/v1/parameters/IGULD:SELF': () => reply(204, ''),
      ...extra,
    },
  });
  t.after(() => srv.close());
  return srv;
}

const ctx = (srv, trust = pinned()) => ({
  address: { host: srv.host, port: srv.port },
  timeoutMs: 3_000,
  trust,
});

test('the real client over TLS: token, measurements, parameters, a write', async (t) => {
  const srv = await smaServer(t);
  const client = new SmaClient();
  const { token, lifeSeconds } = await client.login(ctx(srv), {
    username: 'admin',
    password: 'pass word&=',
  });
  assert.equal(token, 'tok-1');
  assert.equal(lifeSeconds, 3600);
  assert.equal(
    srv.requests[0].headers['content-type'],
    'application/x-www-form-urlencoded;charset=UTF-8',
  );
  const m = await client.measurements(ctx(srv), token);
  assert.equal(m.get('Measurement.Metering.GridMs.TotWhIn.ChaSta'), 123_456);
  const p = await client.parameters(ctx(srv), token);
  assert.equal(p.get('Parameter.Chrg.ActChaMod').value, '4718');
  await client.write(ctx(srv), token, 'Parameter.Chrg.ActChaMod', '4721', {
    timestamp: '2026-10-28T10:00:00.000Z',
  });
  const put = srv.requests.at(-1);
  assert.deepEqual(put.json, {
    values: [
      {
        channelId: 'Parameter.Chrg.ActChaMod',
        timestamp: '2026-10-28T10:00:00.000Z',
        value: '4721',
      },
    ],
  });
  assert.equal(put.headers.connection, 'close');
});

test('the password is never written to another certificate', async (t) => {
  const srv = await smaServer(t);
  const client = new SmaClient();
  await assert.rejects(
    client.login(ctx(srv, pinned('AA:' + PIN.slice(3))), { username: 'admin', password: 'x' }),
    (err) => err.kind === ERROR_KINDS.CERTIFICATE && err.notSent === true,
  );
  assert.equal(srv.requests.length, 0);
});

test('an impostor writing first: refused on its certificate, nothing written to it', async (t) => {
  const imp = await impostorServer();
  t.after(() => imp.close());
  await assert.rejects(
    exchange({
      host: imp.host,
      port: imp.port,
      timeoutMs: 2_000,
      trust: pinned(),
      method: 'POST',
      path: '/api/v1/token',
      body: 'password=secret',
    }),
    (err) => err.kind === ERROR_KINDS.CERTIFICATE,
  );
  assert.equal(imp.received, 0, 'nothing written to the impostor');
});

test('a refused port is unreachable, nothing sent; a silent charger times out after sending', async (t) => {
  const port = await refusePort();
  await assert.rejects(
    exchange({
      host: '127.0.0.1',
      port,
      timeoutMs: 1_000,
      trust: pinned(),
      method: 'GET',
      path: '/',
    }),
    (err) => err.kind === ERROR_KINDS.UNREACHABLE,
  );
  const srv = await smaServer(t, { 'POST /api/v1/measurements/live': 'silent' });
  const started = performance.now();
  await assert.rejects(
    new SmaClient().measurements({ ...ctx(srv), timeoutMs: 300 }, 'tok-1'),
    (err) => err.kind === ERROR_KINDS.TIMEOUT && !err.notSent,
  );
  assert.ok(performance.now() - started < 2_000);
});

test('an answer above 128 KB is cut before it is read whole', async (t) => {
  const srv = await smaServer(t);
  srv.bigBody = 200 * 1024;
  await assert.rejects(
    new SmaClient().parameters(ctx(srv), 'tok-1'),
    (err) => err.kind === ERROR_KINDS.PROTOCOL && /too large/.test(err.message),
  );
});

test('beforeSend refusing: nothing written', async (t) => {
  const srv = await smaServer(t);
  await assert.rejects(
    new SmaClient().write(ctx(srv), 'tok-1', 'Parameter.Chrg.ActChaMod', '4718', {
      timestamp: 'x',
      beforeSend: () => {
        throw new Error('option off');
      },
    }),
    (err) => err.notSent === true,
  );
  assert.equal(srv.requests.length, 0);
});

test('the client writes only the mode and whole amperes', async () => {
  const client = new SmaClient({
    exchange: () => assert.fail('nothing may be sent'),
  });
  for (const [channel, value] of [
    ['Parameter.Chrg.ActChaMod', '4720'],
    ['Parameter.Chrg.ActChaMod', '1'],
    ['Parameter.Inverter.AcALim', '33'],
    ['Parameter.Inverter.AcALim', '5'],
    ['Parameter.Inverter.AcALim', '10.5'],
    ['Parameter.Sys.DevRstr', '1146'],
  ]) {
    await assert.rejects(
      client.write({ address: {} }, 't', channel, value, { timestamp: 'x' }),
      (err) => err.kind === ERROR_KINDS.PROTOCOL && err.notSent,
    );
  }
});

test('the answer parser: chunked, interim answers, bounded head', () => {
  const parser = new AnswerParser();
  const done = parser.push(
    Buffer.from(
      'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n',
    ),
  );
  assert.equal(done, true);
  assert.equal(parser.result().body, 'abc');
  const big = new AnswerParser();
  assert.throws(
    () => big.push(Buffer.from(`HTTP/1.1 200 OK\r\nX: ${'a'.repeat(9000)}`)),
    /Head too large/,
  );
});
