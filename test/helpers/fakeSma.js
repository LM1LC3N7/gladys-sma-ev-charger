// -----------------------------------------------------------------------------
// A fake SMA EV Charger behind the injected `exchange` (no network): its
// token endpoint, its measurements and parameters (shaped as the fixtures of
// ha-sma-ev-charger, Apache-2.0, tests/fixtures), its writes, and failures on
// demand. Delays run on the injected timers (the test clock).
// -----------------------------------------------------------------------------

import { ChargerError, ERROR_KINDS } from '../../src/sma/http.js';

export const HOST = '192.168.1.80';
export const USER = 'gladys-user';
export const PASSWORD = 'S3cret pass!';
export const SERIAL = '1234567890';
export const FP = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase()).join(
  ':',
);
export const OTHER_FP = Array.from({ length: 32 }, (_, i) =>
  (i + 100).toString(16).toUpperCase(),
).join(':');
export const NOW = Date.UTC(2026, 9, 28, 10, 0, 0);

/** The live measurements answer of a charger in `s`. */
export function measurementsOf(s) {
  const channel = (channelId, value) => ({
    channelId,
    componentId: 'IGULD:SELF',
    values: [{ time: '2026-10-28T10:00:00.000Z', ...(value === undefined ? {} : { value }) }],
  });
  return [
    channel('Measurement.ChaSess.WhIn', s.sessionWh),
    channel('Measurement.Chrg.ModSw', s.rotary),
    channel('Measurement.GridMs.A.phsA', s.currents[0]),
    channel('Measurement.GridMs.A.phsB', s.currents[1]),
    channel('Measurement.GridMs.A.phsC', s.currents[2]),
    channel('Measurement.GridMs.Hz', 49.99),
    channel('Measurement.GridMs.PhV.phsA', s.voltages[0]),
    channel('Measurement.GridMs.PhV.phsB', s.voltages[1]),
    channel('Measurement.GridMs.PhV.phsC', s.voltages[2]),
    channel('Measurement.Metering.GridMs.TotWIn.ChaSta', s.power),
    channel('Measurement.Metering.GridMs.TotWhIn.ChaSta', s.meterWh),
    channel('Measurement.Operation.EVeh.ChaStt', s.session),
    channel('Measurement.Operation.EVeh.Health', 307),
    channel('Measurement.Operation.Health', s.health),
    channel('Measurement.Operation.WMaxLimNom'),
  ];
}

/** The parameters answer of a charger in `s`. */
export function parametersOf(s) {
  const p = (channelId, value, extra = {}) => ({
    channelId,
    editable: true,
    state: 'Confirmed',
    timestamp: '2023-12-27T09:52:12.485Z',
    value,
    ...extra,
  });
  return [
    {
      componentId: 'IGULD:SELF',
      values: [
        p('Parameter.Nameplate.SerNum', s.serial, { editable: false }),
        p('Parameter.Nameplate.ModelStr', 'EVC22-3AC-10', { editable: false }),
        p('Parameter.Nameplate.PkgRev', '1.2.23.R', { editable: false }),
        p('Parameter.Nameplate.Vendor', '461', { editable: false, possibleValues: ['461'] }),
        p('Parameter.Nameplate.ARtg', s.rated, { editable: false, max: 32, min: 32 }),
        p('Parameter.Chrg.ActChaMod', s.mode, { possibleValues: s.possibleModes }),
        p('Parameter.Inverter.AcALim', s.limit, { max: s.limitMax, min: s.limitMin }),
        p('Parameter.Wl.Sec.Psk', '****'),
        p('Parameter.Wl.ExsNetw[]', undefined, { values: ['Wifi1'] }),
      ],
    },
  ];
}

const answer = (status, body = '', headers = {}) => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

/**
 * The fake charger. `hooks['METHOD path']` may return an answer
 * `{ status, body, headers }` or one of: 'unreachable' (nothing sent),
 * 'timeout' (sent, never answered), 'reset' (sent, the connection cut);
 * `delay['METHOD path']` (ms, on `timers`) before the answer.
 */
export function fakeSma({ timers = globalThis, ...options } = {}) {
  const sma = {
    username: USER,
    password: PASSWORD,
    fingerprint: FP,
    tokenLife: 3600,
    state: {
      serial: SERIAL,
      session: 200112,
      health: 307,
      rotary: 4718,
      power: 0,
      currents: [0, 0, 0],
      voltages: [233.2, 230.9, 233],
      meterWh: 875_891,
      sessionWh: 8127,
      mode: '4721',
      possibleModes: ['4718', '4721'],
      limit: '16.000',
      limitMin: 6,
      limitMax: 32,
      rated: '32.000',
    },
    tokens: new Set(),
    issued: 0,
    /** Every connection: { fingerprintChecked, request?, closed }. */
    connections: [],
    requests: [],
    writes: [],
    hooks: {},
    delay: {},
    down: false,
    ...options,
  };

  sma.routes = () => sma.requests.map((r) => `${r.method} ${r.path}`);
  sma.count = (route) => sma.routes().filter((r) => r === route).length;

  const handle = (request) => {
    const key = `${request.method} ${request.path}`;
    if (key === 'POST /api/v1/token') {
      const form = new URLSearchParams(request.body);
      if (
        form.get('grant_type') === 'password' &&
        form.get('username') === sma.username &&
        form.get('password') === sma.password
      ) {
        sma.issued += 1;
        const token = `tok-${sma.issued}`;
        sma.tokens.add(token);
        return answer(200, {
          access_token: token,
          refresh_token: `refresh-${sma.issued}`,
          expires_in: sma.tokenLife,
          token_type: 'Bearer',
        });
      }
      return answer(401, { error: 'invalid_grant' });
    }
    const token = /^Bearer (.+)$/.exec(request.headers.Authorization ?? '')?.[1];
    if (!token || !sma.tokens.has(token)) {
      return answer(401, '');
    }
    if (key === 'POST /api/v1/measurements/live') {
      return answer(200, measurementsOf(sma.state));
    }
    if (key === 'POST /api/v1/parameters/search') {
      return answer(200, parametersOf(sma.state));
    }
    if (key === 'PUT /api/v1/parameters/IGULD:SELF') {
      const { channelId, value } = JSON.parse(request.body).values[0];
      sma.writes.push({ channelId, value });
      if (channelId === 'Parameter.Chrg.ActChaMod') sma.state.mode = value;
      if (channelId === 'Parameter.Inverter.AcALim') sma.state.limit = `${value}.000`;
      return answer(204, '');
    }
    return answer(404, '');
  };

  sma.exchange = async ({ host, port, timeoutMs, trust, onOpen, beforeSend, ...request }) => {
    const connection = {
      host,
      port,
      closed: false,
      sent: false,
      fingerprintChecked: false,
      close() {
        if (connection.closed) return;
        connection.closed = true;
        connection.abort?.();
      },
    };
    sma.connections.push(connection);
    if (sma.down) {
      throw new ChargerError(ERROR_KINDS.UNREACHABLE, 'Unreachable: ECONNREFUSED');
    }
    try {
      onOpen?.(connection);
      if (connection.closed) {
        throw new ChargerError(ERROR_KINDS.ABORTED, 'Session given up', { notSent: true });
      }
      await trust(sma.fingerprint);
      connection.fingerprintChecked = true;
      if (connection.closed) {
        throw new ChargerError(ERROR_KINDS.ABORTED, 'Session given up', { notSent: true });
      }
      const key = `${request.method} ${request.path}`;
      const hook = sma.hooks[key]?.(request, sma);
      if (hook === 'unreachable') {
        throw new ChargerError(ERROR_KINDS.UNREACHABLE, 'Unreachable: ECONNREFUSED');
      }
      try {
        beforeSend?.();
      } catch (err) {
        throw Object.assign(err, { notSent: true, beforeSend: true });
      }
      connection.sent = true;
      const recorded = { ...request, headers: { ...(request.headers ?? {}) } };
      sma.requests.push(recorded);
      connection.request = recorded;
      const wait = sma.delay[key] ?? 0;
      if (hook === 'timeout' || wait > 0) {
        await new Promise((resolve, reject) => {
          const timer = timers.setTimeout(
            () =>
              hook === 'timeout'
                ? reject(new ChargerError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout'))
                : resolve(),
            hook === 'timeout' ? timeoutMs : wait,
          );
          connection.abort = () => {
            timers.clearTimeout(timer);
            reject(new ChargerError(ERROR_KINDS.ABORTED, 'Session given up', { notSent: false }));
          };
          if (wait > timeoutMs && hook !== 'timeout') {
            timers.clearTimeout(timer);
            timers.setTimeout(
              () => reject(new ChargerError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout')),
              timeoutMs,
            );
          }
        });
      }
      if (connection.closed) {
        throw new ChargerError(ERROR_KINDS.ABORTED, 'Session given up');
      }
      if (hook === 'reset') {
        throw new ChargerError(ERROR_KINDS.TIMEOUT, 'Connection lost');
      }
      if (hook && typeof hook === 'object') {
        return answer(hook.status, hook.body ?? '', hook.headers ?? {});
      }
      return handle(recorded);
    } finally {
      connection.closed = true;
    }
  };
  return sma;
}
