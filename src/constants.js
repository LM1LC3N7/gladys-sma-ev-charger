// -----------------------------------------------------------------------------
// SMA EV Charger constants, limits and timings.
//
// An SMA EV Charger (EVC7.4-1AC-10, EVC22-3AC-10) or eCharger has a local web
// API, as pysmaev (MIT, alengwenus/pysmaev) and ha-sma-ev-charger (Apache-2.0,
// alengwenus/ha-sma-ev-charger, the Home Assistant integration) read it:
//   - `POST /api/v1/token` (form: grant_type=password, username, password):
//     an access token (`access_token`, `expires_in` seconds) for the bearer
//     header of the other requests;
//   - `POST /api/v1/measurements/live` [{"componentId":"IGULD:SELF"}]: the
//     measurements (channel id -> [{ time, value }]);
//   - `POST /api/v1/parameters/search` {"queryItems":[{"componentId":"IGULD:SELF"}]}:
//     the parameters (channel id -> value as text, min, max, possibleValues);
//   - `PUT /api/v1/parameters/IGULD:SELF` {"values":[{channelId, timestamp, value}]}:
//     writes a parameter.
// The certificate of the charger is self-signed: it is pinned at the first
// connection (its SHA-256 fingerprint kept in /data) and checked at every
// connection, BEFORE any byte is written (the password included).
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 443;

/** The component of the charger itself (pysmaev reads and writes only it). */
export const COMPONENT = 'IGULD:SELF';

export const PATHS = {
  token: '/api/v1/token',
  measurements: '/api/v1/measurements/live',
  parameters: '/api/v1/parameters/search',
  setParameter: `/api/v1/parameters/${COMPONENT}`,
};

/** The bodies of the two reads, exactly as pysmaev sends them. */
export const BODIES = {
  measurements: `[{"componentId":"${COMPONENT}"}]`,
  parameters: `{"queryItems":[{"componentId":"${COMPONENT}"}]}`,
};

/** The measurement channels read (ha-sma-ev-charger's sensor.py). */
export const CHANNELS = {
  /** Energy of the charging session (Wh). */
  SESSION_ENERGY: 'Measurement.ChaSess.WhIn',
  /** Position of the rotary switch (4950 smart charging, 4718 boost charging). */
  ROTARY: 'Measurement.Chrg.ModSw',
  CURRENT_L1: 'Measurement.GridMs.A.phsA',
  CURRENT_L2: 'Measurement.GridMs.A.phsB',
  CURRENT_L3: 'Measurement.GridMs.A.phsC',
  VOLTAGE_L1: 'Measurement.GridMs.PhV.phsA',
  VOLTAGE_L2: 'Measurement.GridMs.PhV.phsB',
  VOLTAGE_L3: 'Measurement.GridMs.PhV.phsC',
  /** Power of the charging station (W). */
  POWER: 'Measurement.Metering.GridMs.TotWIn.ChaSta',
  /** Meter reading of the charging station (Wh): the energy index. */
  METER: 'Measurement.Metering.GridMs.TotWhIn.ChaSta',
  /** Charging session status (SESSION_STATES). */
  SESSION_STATUS: 'Measurement.Operation.EVeh.ChaStt',
  /** Status of the connected vehicle (HEALTH). */
  VEHICLE_HEALTH: 'Measurement.Operation.EVeh.Health',
  /** Status of the charging station (HEALTH). */
  HEALTH: 'Measurement.Operation.Health',
};

/** The parameter channels read; only MODE and CURRENT_LIMIT are ever written. */
export const PARAMS = {
  /** Operating mode of the charge session (MODES): the start, the stop, the mode. */
  MODE: 'Parameter.Chrg.ActChaMod',
  /** Charge current limit (A, "16.000"), with its min and max. */
  CURRENT_LIMIT: 'Parameter.Inverter.AcALim',
  /** Rated current of the charger (A). */
  RATED_CURRENT: 'Parameter.Nameplate.ARtg',
  SERIAL: 'Parameter.Nameplate.SerNum',
  MODEL: 'Parameter.Nameplate.ModelStr',
  FIRMWARE: 'Parameter.Nameplate.PkgRev',
  /** 461 = SMA (pysmaev's device_info). */
  VENDOR: 'Parameter.Nameplate.Vendor',
};

/** The vendor code of SMA. */
export const SMA_VENDOR = '461';

/** Operating mode of the charge session (`Parameter.Chrg.ActChaMod`), pysmaev's codes. */
export const MODES = {
  BOOST: '4718',
  OPTIMIZED: '4719',
  SETPOINT: '4720',
  STOP: '4721',
};

/** The modes the "Charging mode" select offers (setpoint charging needs an energy and an end time). */
export const MODE_OPTIONS = {
  boost: MODES.BOOST,
  optimized: MODES.OPTIMIZED,
  stop: MODES.STOP,
};

/** Position of the rotary switch (`Measurement.Chrg.ModSw`). */
export const ROTARY = { 4950: 'smart', 4718: 'boost' };

/** Status of the station and of the vehicle (`…Health`). */
export const HEALTH = { 307: 'ok', 455: 'warning', 35: 'alarm', 303: 'off' };

/** Our states, from the charging session status, plus `offline` (no answer). */
export const STATE = {
  UNKNOWN: 'unknown',
  STANDBY: 'standby',
  CONNECTED: 'connected',
  CHARGING: 'charging',
  LOCKED: 'locked',
  ERROR: 'error',
  OFFLINE: 'offline',
};

/** Charging session status (`Measurement.Operation.EVeh.ChaStt`) -> our state. */
export const SESSION_STATES = {
  200111: STATE.STANDBY,
  200112: STATE.CONNECTED,
  200113: STATE.CHARGING,
  5169: STATE.LOCKED,
  200115: STATE.ERROR,
};

/** A vehicle is plugged in: the only states where "Start charging" is sent. */
export const PLUGGED_STATES = new Set([STATE.CONNECTED, STATE.CHARGING]);

/**
 * The charging current, in whole amperes: never below 6 A (IEC 61851, the
 * lowest current a vehicle accepts) nor the minimum the charger gives, never
 * above the ceiling of the configuration (16 A by default, 32 A at most),
 * the maximum of the charger for this parameter, nor its rated current.
 */
export const CURRENT = {
  min: 6,
  max: 32,
  defaultCeiling: 16,
  /** A current read back within this tolerance is the one asked. */
  tolerance: 0.1,
};

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  STATUS: 'status',
  MODE: 'charging-mode',
  ROTARY: 'rotary-switch',
  HEALTH: 'station-status',
  CONNECTOR: 'connector-status',
  CHARGING_STATE: 'charging-state',
  PLUGGED: 'plugged',
  STOPPED: 'charge-stopped',
  ERROR: 'error',
  POWER: 'power',
  CURRENT_L1: 'current-l1',
  CURRENT_L2: 'current-l2',
  CURRENT_L3: 'current-l3',
  VOLTAGE_L1: 'voltage-l1',
  VOLTAGE_L2: 'voltage-l2',
  VOLTAGE_L3: 'voltage-l3',
  CURRENT_LIMIT: 'current-limit',
  ENERGY_INDEX: 'energy-index',
  SESSION_ENERGY: 'session-energy',
  STOP: 'stop-charge',
  START: 'start-charge',
  SET_MODE: 'set-mode',
  SET_CURRENT: 'set-current',
};

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
  ACCEPT_HELD: 'accept_held_index',
  TRUST_CERTIFICATE: 'trust_certificate',
};

/** The value a `button/push` feature sends (BUTTON_PUSH.PRESSED of the core). */
export const PRESSED = 1;

/** The poll interval of the configuration, in seconds (each read is two requests). */
export const POLL_INTERVAL = {
  min: 15,
  max: 3600,
  default: 30,
};

/**
 * The guard of the energy index (src/guard.js): an SMA EV Charger delivers
 * 22 kW at most (32 A on three phases); 25 kW on average since the last
 * value is already implausible. 0.5 kWh always allowed on top.
 */
export const GUARD_LIMITS = { maxKw: 25, slackKwh: 0.5 };

export const LIMITS = {
  /** Gladys: 300 states per minute. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** One answer (the parameters are some 15 KB). */
  responseBytes: 128 * 1024,
  /** The status line and the headers of an answer. */
  headerBytes: 8 * 1024,
  /** Channels of one answer, values of one channel, possible values of a parameter, at most. */
  channels: 1000,
  values: 10,
  possibleValues: 32,
  /** Longest text kept from an answer (model, firmware). */
  textLength: 60,
  /** The access token: printable ASCII, bounded. */
  tokenLength: 4096,
  /** User name and password: printable ASCII, bounded. */
  secretMin: 1,
  secretMax: 256,
  /** Index guards kept in /data at most (one per index feature). */
  indexStates: 8,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** One request of the polling (its own TLS connection and handshake included). */
  readTimeout: 8 * SECOND,
  /** Failed reads: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** 429: Retry-After bounded to 1 min .. 6 h, 5 min without. A 5xx pauses as a failed read. */
  rateLimitMin: MINUTE,
  rateLimitMax: 6 * HOUR,
  rateLimitDefault: 5 * MINUTE,
  /** Credentials refused: "Test the connection" or a stop clicked try a login at most this often. */
  blockedTestSpacing: MINUTE,
  /** 401/403 on a read with a token just given: the wait doubles from 5 min up to 1 h. */
  forbiddenBackoff: [5 * MINUTE, 10 * MINUTE, 20 * MINUTE, 40 * MINUTE, HOUR],
  /** The access token is used until 90 % of its life (pysmaev renews it then), 1 min .. 24 h. */
  tokenLifeMin: MINUTE,
  tokenLifeMax: 24 * HOUR,
  tokenLifeDefault: HOUR,
  /** The time of the last read is written to /data at most this often. */
  lastReadSave: MINUTE,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** The two clicks of "Accept the held index" / "Trust the new certificate": 3 s to 1 min apart. */
  confirmAfter: 3 * SECOND,
  confirmWithin: MINUTE,
  /** getConfig() failed in `connected`: asked again after 5 s, 15 s, 30 s, then every minute. */
  configRetry: [5 * SECOND, 15 * SECOND, 30 * SECOND, MINUTE],
  /**
   * Commands (Gladys waits 5 s for the ack): the command must leave by 3.5 s
   * after the click (logins and fresh reads included), or it is refused
   * unsent; the answer is awaited until 4.3 s, after which the command is
   * "sent, without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** Time left for the read that confirms a write, at least (else "sent, without confirmation"). */
  confirmReadMin: 400,
  /** Time left to send after the fresh read, at least. */
  commandMinSend: 300,
  /** A stop not sent (unreachable, cut) is tried again within its budget, this far apart. */
  stopRetryGap: 250,
  /**
   * A stop not applied is kept (in /data) and sent again on its own rhythm,
   * whatever the interval, the backoff or a pause of the reads, until it is
   * applied, a start leaves Gladys, a read shows it stopped or another mode
   * twice in a row; never dropped by the time. A 429 or 5xx answered to it
   * waits for its Retry-After, bounded.
   */
  pendingStopRetry: 30 * SECOND,
  /** A stop refused by the same 4xx this many times in a row is given up (said in the status and the badge). */
  stopRefusalsMax: 3,
  pendingStopWaitMax: 5 * MINUTE,
  /** Reads after a command, spaced: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A sent command keeps its guard until the charger shows what it asked, or 90 s. */
  guard: 90 * SECOND,
  /** A stop sent again at most this often while its guard holds (contradicted by a read). */
  stopReasserts: 2,
  /** One start, mode or current change a minute; a stop is never limited. */
  changeMinInterval: MINUTE,
  /** A session given up for a stop: waited for at most this long to close. */
  preemptWait: 500,
};
