// -----------------------------------------------------------------------------
// The local web API of an SMA EV Charger, ported from pysmaev (MIT,
// alengwenus/pysmaev 0.1.10, commit 131e1eb) and ha-sma-ev-charger
// (Apache-2.0, alengwenus/ha-sma-ev-charger 1.4.1, commit 0cb1ee1): the token
// request (form, grant_type=password), the live measurements and the
// parameters of the component `IGULD:SELF`, a parameter written (PUT, with a
// timestamp in the charger's format), the channel ids, the operating modes,
// the session states and the status codes.
//
// Every request is one exchange on its own connection (src/sma/http.js), its
// certificate checked against the pin before any byte is written. Nothing is
// retried here: the app spaces its new tries, and a write is never retried
// (it may have reached the charger). pysmaev's token refresh by the refresh
// token is not kept: a new token is asked with the credentials when the one
// in memory is old (90 % of its life) or refused.
//
// The answers come from the network: only own fields of plain objects are
// read, each with its exact type (a missing or mistyped value is undefined,
// never a default, so that a command is refused rather than decided on a
// guess); channels are kept in a Map, and only the channels this module
// knows. JSON.parse keeps `__proto__` as a plain own key: it never reaches a
// prototype, and it is never read.
// -----------------------------------------------------------------------------

import {
  BODIES,
  CHANNELS,
  COMPONENT,
  HEALTH,
  LIMITS,
  MODES,
  PARAMS,
  PATHS,
  ROTARY,
  SESSION_STATES,
  STATE,
} from '../constants.js';
import { ChargerError, ERROR_KINDS, exchange as httpExchange } from './http.js';

const plain = (data) => data !== null && typeof data === 'object' && !Array.isArray(data);
const own = (object, key) =>
  plain(object) && Object.hasOwn(object, key) ? object[key] : undefined;

/** A number, or a text that is exactly one (the parameters are texts: "16.000"), else undefined. */
export function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^-?\d{1,12}(?:\.\d{1,12})?$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/** A short text from the charger, without control characters. */
export function text(value, max = LIMITS.textLength) {
  if (typeof value !== 'string') {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean === '' ? undefined : clean.slice(0, max);
}

/** The serial number of the charger ("1234567890") in lower case, else undefined. */
export function serialOf(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const serial = value.trim().toLowerCase();
  return /^[0-9a-z](?:[0-9a-z_-]{2,38}[0-9a-z])$/.test(serial) ? serial : undefined;
}

const CHANNEL_ID = /^[A-Za-z0-9._[\]-]{1,120}$/;
const KNOWN_MEASUREMENTS = new Set(Object.values(CHANNELS));
const KNOWN_PARAMETERS = new Set(Object.values(PARAMS));
const notShape = (what) => new ChargerError(ERROR_KINDS.PROTOCOL, `Not ${what}`);

/**
 * `POST /api/v1/measurements/live`: `[{ channelId, componentId, values: [{ time, value }] }]`.
 * Returns Map(channelId -> number) for the known channels of the charger
 * itself; a value that is not a finite number is left out (unknown).
 */
export function parseMeasurements(data) {
  if (!Array.isArray(data) || data.length > LIMITS.channels) {
    throw notShape('a list of measurements');
  }
  const values = new Map();
  for (const item of data) {
    const id = own(item, 'channelId');
    if (
      typeof id !== 'string' ||
      !CHANNEL_ID.test(id) ||
      !KNOWN_MEASUREMENTS.has(id) ||
      own(item, 'componentId') !== COMPONENT
    ) {
      continue;
    }
    const list = own(item, 'values');
    if (!Array.isArray(list) || list.length === 0 || list.length > LIMITS.values) {
      continue;
    }
    const value = own(list[0], 'value');
    if (typeof value === 'number' && Number.isFinite(value)) {
      values.set(id, value);
    }
  }
  return values;
}

/**
 * `POST /api/v1/parameters/search`: `[{ componentId, values: [{ channelId,
 * value, min?, max?, possibleValues? }] }]`. Returns Map(channelId -> { value
 * (text), min, max, possibleValues }) for the known channels of the charger
 * itself. No component of the charger: not the answer of an SMA EV Charger.
 */
export function parseParameters(data) {
  if (!Array.isArray(data) || data.length > LIMITS.channels) {
    throw notShape('a list of parameters');
  }
  const component = data.find((c) => own(c, 'componentId') === COMPONENT);
  const list = own(component, 'values');
  if (!Array.isArray(list) || list.length > LIMITS.channels) {
    throw notShape('the parameters of the charger');
  }
  const params = new Map();
  for (const item of list) {
    const id = own(item, 'channelId');
    if (typeof id !== 'string' || !CHANNEL_ID.test(id) || !KNOWN_PARAMETERS.has(id)) {
      continue;
    }
    const raw = own(item, 'value');
    const value =
      typeof raw === 'string' && raw.length <= 200
        ? raw
        : typeof raw === 'number' && Number.isFinite(raw)
          ? String(raw)
          : undefined;
    const possible = own(item, 'possibleValues');
    const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    params.set(id, {
      value,
      min: finite(own(item, 'min')),
      max: finite(own(item, 'max')),
      possibleValues:
        Array.isArray(possible) &&
        possible.length <= LIMITS.possibleValues &&
        possible.every((v) => typeof v === 'string' && /^\d{1,8}$/.test(v))
          ? [...possible]
          : undefined,
    });
  }
  return params;
}

const measure = (value, min, max) =>
  value !== undefined && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
const code = (value) => (Number.isInteger(value) && value >= 0 ? value : undefined);
const mapped = (table, value) =>
  value !== undefined && Object.hasOwn(table, value) ? table[value] : undefined;

/** The measurements -> the state of the charger, its meter and its readings. */
export function measuresOf(m) {
  const session = code(m.get(CHANNELS.SESSION_STATUS));
  const state =
    session === undefined ? STATE.UNKNOWN : (mapped(SESSION_STATES, session) ?? STATE.UNKNOWN);
  const healthCode = code(m.get(CHANNELS.HEALTH));
  const health = mapped(HEALTH, healthCode);
  const vehicleHealth = mapped(HEALTH, code(m.get(CHANNELS.VEHICLE_HEALTH)));
  const meter = measure(m.get(CHANNELS.METER), 0, 1e12);
  const sessionWh = measure(m.get(CHANNELS.SESSION_ENERGY), 0, 1e9);
  const known = state !== STATE.UNKNOWN || health !== undefined;
  return {
    session,
    state,
    health,
    healthCode,
    vehicleHealth,
    rotary: mapped(ROTARY, code(m.get(CHANNELS.ROTARY))),
    power: measure(m.get(CHANNELS.POWER), 0, 100_000),
    currents: [CHANNELS.CURRENT_L1, CHANNELS.CURRENT_L2, CHANNELS.CURRENT_L3].map((id) =>
      measure(m.get(id), 0, 100),
    ),
    voltages: [CHANNELS.VOLTAGE_L1, CHANNELS.VOLTAGE_L2, CHANNELS.VOLTAGE_L3].map((id) =>
      measure(m.get(id), 0, 500),
    ),
    totalEnergy: meter === undefined ? undefined : meter / 1000,
    sessionEnergy: sessionWh === undefined ? undefined : sessionWh / 1000,
    error: known ? state === STATE.ERROR || health === 'alarm' : undefined,
  };
}

const MODE_CODES = new Set(Object.values(MODES));

/** The parameters -> identity, operating mode and charging current of the charger. */
export function controlOf(p) {
  const param = (id) => p.get(id);
  const mode = param(PARAMS.MODE)?.value;
  const limit = param(PARAMS.CURRENT_LIMIT);
  const amps = (v) => measure(numberOf(v), 0, 80);
  return {
    serial: serialOf(param(PARAMS.SERIAL)?.value),
    model: text(param(PARAMS.MODEL)?.value, 40),
    firmware: text(param(PARAMS.FIRMWARE)?.value, 30),
    vendor: text(param(PARAMS.VENDOR)?.value, 10),
    /** One of MODES, 'other' for another code, undefined when not read. */
    mode: typeof mode === 'string' ? (MODE_CODES.has(mode) ? mode : 'other') : undefined,
    /** The modes the charger accepts now (undefined: not given). */
    possibleModes: param(PARAMS.MODE)?.possibleValues,
    currentLimit: amps(limit?.value),
    limitMin: amps(limit?.min),
    limitMax: amps(limit?.max),
    rated: amps(param(PARAMS.RATED_CURRENT)?.value),
  };
}

/**
 * Retry-After in ms, else undefined: seconds, or an HTTP date compared with
 * the `Date` header of the same answer (never with our own clock: an answer
 * without a readable `Date` gives no wait).
 */
export function retryAfterOf(headers) {
  const header = headers?.['retry-after'];
  if (typeof header !== 'string' || header.trim() === '') {
    return undefined;
  }
  if (/^\s*\d{1,6}\s*$/.test(header)) {
    return Number(header) * 1000;
  }
  const at = Date.parse(header);
  const date = Date.parse(String(headers?.date ?? ''));
  return Number.isNaN(at) || Number.isNaN(date) ? undefined : Math.max(0, at - date);
}

/** The error of a non-2xx answer (the body is never kept). */
function statusError(response, { token = false, write = false } = {}) {
  const status = response.status;
  if (status === 429) {
    return new ChargerError(ERROR_KINDS.RATE_LIMITED, 'HTTP 429', {
      status,
      retryAfter: retryAfterOf(response.headers),
    });
  }
  if (token && (status === 400 || status === 401 || status === 403)) {
    return new ChargerError(ERROR_KINDS.AUTH, `HTTP ${status}`, { status });
  }
  if (!token && (status === 401 || status === 403)) {
    // With a token: no right to it (or the token expired), never a refused password.
    return new ChargerError(ERROR_KINDS.FORBIDDEN, `HTTP ${status}`, { status });
  }
  if (write && status >= 400 && status < 500) {
    return new ChargerError(ERROR_KINDS.REJECTED, `HTTP ${status}`, { status });
  }
  return new ChargerError(ERROR_KINDS.HTTP, `HTTP ${status}`, { status });
}

/** The reason of an error for a log or a message: its kind and status, never the answer. */
export function errorReason(err) {
  if (Number.isInteger(err?.status)) {
    return `HTTP ${err.status}`;
  }
  return typeof err?.kind === 'string' ? err.kind : 'error';
}

const ok = (response) => response.status >= 200 && response.status <= 299;

/** The JSON of an answer, else a protocol error. */
function jsonOf(response) {
  try {
    return JSON.parse(response.body);
  } catch {
    throw new ChargerError(ERROR_KINDS.PROTOCOL, 'Not JSON');
  }
}

/** The timestamp of a written value, in the charger's format: "2026-10-28T10:00:00.000Z". */
export const timestampOf = (wallMs) => new Date(wallMs).toISOString();

const TOKEN = /^[\x21-\x7e]+$/;

export class SmaClient {
  /** `exchange`: one request on its own connection (src/sma/http.js; a fake in the tests). */
  constructor({ exchange = httpExchange } = {}) {
    this.exchange = exchange;
  }

  /**
   * `ctx`: `{ address, timeoutMs, trust, onOpen }`, the exchange of the app
   * (certificate pinned, session that can be given up). Returns the answer.
   */
  send(ctx, request) {
    return this.exchange({
      host: ctx.address.host,
      port: ctx.address.port,
      timeoutMs: ctx.timeoutMs,
      trust: ctx.trust,
      onOpen: ctx.onOpen,
      ...request,
    });
  }

  /**
   * A new access token with the credentials (pysmaev's request_token with
   * force_credentials): `{ token, lifeMs }`. The password leaves only once
   * the certificate matched (in `send`). The token is memory only.
   */
  async login(ctx, { username, password }) {
    const body = `grant_type=password&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
    const answer = await this.send(ctx, {
      method: 'POST',
      path: PATHS.token,
      body,
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    });
    if (!ok(answer)) {
      throw statusError(answer, { token: true });
    }
    const data = jsonOf(answer);
    const token = own(data, 'access_token');
    if (typeof token !== 'string' || token.length > LIMITS.tokenLength || !TOKEN.test(token)) {
      throw new ChargerError(ERROR_KINDS.PROTOCOL, 'No access token');
    }
    const expires = own(data, 'expires_in');
    return {
      token,
      lifeSeconds: Number.isInteger(expires) && expires > 0 ? expires : undefined,
    };
  }

  async read(ctx, token, path, body) {
    const answer = await this.send(ctx, {
      method: 'POST',
      path,
      body,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!ok(answer)) {
      throw statusError(answer);
    }
    return jsonOf(answer);
  }

  async measurements(ctx, token) {
    return parseMeasurements(await this.read(ctx, token, PATHS.measurements, BODIES.measurements));
  }

  async parameters(ctx, token) {
    return parseParameters(await this.read(ctx, token, PATHS.parameters, BODIES.parameters));
  }

  /**
   * One parameter written, never retried. `beforeSend()` runs right before
   * the bytes go (the last checks of a command, the deadline): what it throws
   * is rethrown marked `notSent`. Only the operating mode (one of MODES) and
   * the charging current (whole amperes, 6 to 32 A) are ever written.
   */
  async write(ctx, token, channelId, value, { timestamp, beforeSend }) {
    const valid =
      (channelId === PARAMS.MODE && MODE_CODES.has(value) && value !== MODES.SETPOINT) ||
      (channelId === PARAMS.CURRENT_LIMIT &&
        typeof value === 'string' &&
        /^\d{1,2}$/.test(value) &&
        Number(value) >= 6 &&
        Number(value) <= 32);
    if (!valid || typeof timestamp !== 'string') {
      throw new ChargerError(ERROR_KINDS.PROTOCOL, 'Bad command', { notSent: true });
    }
    const body = JSON.stringify({ values: [{ channelId, timestamp, value }] });
    const answer = await this.send(ctx, {
      method: 'PUT',
      path: PATHS.setParameter,
      body,
      headers: { Authorization: `Bearer ${token}` },
      beforeSend,
    });
    if (!ok(answer)) {
      throw statusError(answer, { write: true });
    }
  }
}
