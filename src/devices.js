// -----------------------------------------------------------------------------
// The charger -> one Gladys device and its states (pure).
//
// `ext:<selector>:sma:<serial>`: one device per charger, keyed by its serial
// number (`Parameter.Nameplate.SerNum`, in lower case), never by its IP
// address (it may change). The feature roles (the last part of their
// external ids) are published forever: never rename them. Every role is
// always built (a single-phase charger leaves its L2 and L3 features empty),
// so a republished device never loses a feature.
//
// No switch, no writable binary: a "turn everything off" (Google Home, Alexa,
// HomeKit, MCP, `switch.*` scenes) must never reach a charge command. Stopping
// and starting are two `button/push` features, the charging mode and the
// charging current two `text/select`.
//
// Categories and units are those the core lists
// (DEVICE_FEATURE_UNITS_BY_CATEGORY): W, A and V on `energy-sensor`
// (instantaneous readings) and the energy index (kWh, `energy-sensor/index`,
// the meter reading of the charging station: it goes through the guard of
// src/guard.js); kWh of the session on `electrical-vehicle-charge/
// last-charge-energy-consumption`, A on `electrical-vehicle-charge/
// target-current` (the charge current limit, read only).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { CURRENT, FEATURES, MODES, MODE_OPTIONS, PLUGGED_STATES, STATE } from './constants.js';
import {
  FEATURE_NAMES,
  HEALTH_NAMES,
  MODE_NAMES,
  ROTARY_NAMES,
  STATE_NAMES,
  STOPPED,
  word,
} from './i18n.js';

/** CHARGING_STATION_CONNECTOR_STATUS of the core (server/utils/constants.js). */
export const CONNECTOR_STATUS = {
  AVAILABLE: 0,
  OCCUPIED: 1,
  RESERVED: 2,
  UNAVAILABLE: 3,
  FAULTED: 4,
};

/** CHARGING_STATION_CHARGING_STATE of the core (OCPP 2.0.1 chargingState). */
export const CHARGING_STATE = {
  CHARGING: 0,
  EV_CONNECTED: 1,
  PAUSED_BY_VEHICLE: 2,
  PAUSED_BY_CHARGER: 3,
  IDLE: 4,
  DISCHARGING: 5,
};

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const binary = sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
const button = {
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};
const select = {
  category: C.TEXT,
  type: T.TEXT.SELECT,
  min: 0,
  max: 0,
  read_only: false,
  has_feedback: true,
  keep_history: false,
};
const current = sensor({
  category: C.ENERGY_SENSOR,
  type: T.ENERGY_SENSOR.CURRENT,
  unit: U.AMPERE,
  min: 0,
  max: 100,
});
const voltage = sensor({
  category: C.ENERGY_SENSOR,
  type: T.ENERGY_SENSOR.VOLTAGE,
  unit: U.VOLT,
  min: 0,
  max: 500,
});
const text = sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0 });

/** The features, by role, in display order (the selects get their options in buildDevice). */
export const DEFINITIONS = {
  [FEATURES.STATUS]: text,
  [FEATURES.MODE]: text,
  [FEATURES.ROTARY]: text,
  [FEATURES.HEALTH]: text,
  [FEATURES.CONNECTOR]: sensor({
    category: C.CHARGING_STATION,
    type: T.CHARGING_STATION.CONNECTOR_STATUS,
    min: 0,
    max: 4,
  }),
  [FEATURES.CHARGING_STATE]: sensor({
    category: C.CHARGING_STATION,
    type: T.CHARGING_STATION.CHARGING_STATE,
    min: 0,
    max: 5,
  }),
  [FEATURES.PLUGGED]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.PLUGGED,
    min: 0,
    max: 1,
  }),
  [FEATURES.STOPPED]: binary,
  [FEATURES.ERROR]: binary,
  [FEATURES.POWER]: sensor({
    category: C.ENERGY_SENSOR,
    type: T.ENERGY_SENSOR.POWER,
    unit: U.WATT,
    min: 0,
    max: 50_000,
  }),
  [FEATURES.CURRENT_L1]: current,
  [FEATURES.CURRENT_L2]: current,
  [FEATURES.CURRENT_L3]: current,
  [FEATURES.VOLTAGE_L1]: voltage,
  [FEATURES.VOLTAGE_L2]: voltage,
  [FEATURES.VOLTAGE_L3]: voltage,
  [FEATURES.CURRENT_LIMIT]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.TARGET_CURRENT,
    unit: U.AMPERE,
    min: 0,
    max: 80,
  }),
  [FEATURES.ENERGY_INDEX]: sensor({
    category: C.ENERGY_SENSOR,
    type: T.ENERGY_SENSOR.INDEX,
    unit: U.KILOWATT_HOUR,
    min: 0,
    max: 100_000_000,
  }),
  [FEATURES.SESSION_ENERGY]: sensor({
    category: C.ELECTRICAL_VEHICLE_CHARGE,
    type: T.ELECTRICAL_VEHICLE_CHARGE.LAST_CHARGE_ENERGY_CONSUMPTION,
    unit: U.KILOWATT_HOUR,
    min: 0,
    max: 1_000,
  }),
  [FEATURES.STOP]: button,
  [FEATURES.START]: button,
  [FEATURES.SET_MODE]: select,
  [FEATURES.SET_CURRENT]: select,
};

export const ROLES = Object.keys(DEFINITIONS);
export const COMMAND_ROLES = [
  FEATURES.STOP,
  FEATURES.START,
  FEATURES.SET_MODE,
  FEATURES.SET_CURRENT,
];

export const chargerIds = (gladys, serial) => gladys.externalIds('sma', serial);

const SERIAL = '[0-9a-z](?:[0-9a-z_-]{2,38}[0-9a-z])';

/** The serial and the role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string') {
    return undefined;
  }
  const match = new RegExp(`:sma:(${SERIAL}):([a-z0-9-]+)$`).exec(externalId);
  return match && ROLES.includes(match[2]) ? { serial: match[1], role: match[2] } : undefined;
}

/** The serial of one of our device external ids, else undefined. */
export function parseDeviceId(externalId) {
  const match = new RegExp(`:sma:(${SERIAL})$`).exec(String(externalId ?? ''));
  return match ? match[1] : undefined;
}

/** The options of the current select: whole amperes from 6 A to the ceiling. */
export function currentOptions(ceiling) {
  const options = [];
  for (let amps = CURRENT.min; amps <= ceiling; amps += 1) {
    options.push({ value: String(amps), label: `${amps} A`, sort_order: amps - CURRENT.min });
  }
  return options;
}

/** The options of the mode select (labels as plain strings: the core refuses anything else). */
export function modeOptions(language) {
  return Object.entries(MODE_OPTIONS).map(([value, code], i) => ({
    value,
    label: word(MODE_NAMES[code], language),
    sort_order: i,
  }));
}

export const deviceName = (charger) => `SMA EV Charger ${charger.serial.slice(-4).toUpperCase()}`;

/**
 * The Gladys device of the charger. `ceiling`: the highest current the
 * commands accept now (the select is only an offer: the command checks the
 * ceiling again).
 */
export function buildDevice(gladys, charger, { ceiling, language }) {
  const ids = chargerIds(gladys, charger.serial);
  const params = [{ name: 'serial_number', value: charger.serial }];
  if (charger.control?.model) {
    params.push({ name: 'model', value: charger.control.model });
  }
  if (charger.control?.firmware) {
    params.push({ name: 'firmware', value: charger.control.firmware });
  }
  return {
    name: deviceName(charger),
    external_id: ids.device,
    model: charger.control?.model ?? 'SMA EV Charger',
    should_poll: false,
    features: ROLES.map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...DEFINITIONS[role],
      ...(role === FEATURES.SET_CURRENT ? { supported_options: currentOptions(ceiling) } : {}),
      ...(role === FEATURES.SET_MODE ? { supported_options: modeOptions(language) } : {}),
    })),
    params,
  };
}

/** The connector, as the core's charging-station category reads it (undefined: unknown). */
export function connectorOf(state) {
  switch (state) {
    case STATE.OFFLINE:
      return CONNECTOR_STATUS.UNAVAILABLE;
    case STATE.STANDBY:
      return CONNECTOR_STATUS.AVAILABLE;
    case STATE.CONNECTED:
    case STATE.CHARGING:
      return CONNECTOR_STATUS.OCCUPIED;
    case STATE.ERROR:
      return CONNECTOR_STATUS.FAULTED;
    default:
      return undefined;
  }
}

/**
 * The charging state (OCPP's chargingState). No vehicle, locked or an error:
 * IDLE, so a scene never keeps reading "charging" after the car left.
 */
export function chargingStateOf(state, stopped) {
  switch (state) {
    case STATE.CHARGING:
      return CHARGING_STATE.CHARGING;
    case STATE.CONNECTED:
      return stopped === true ? CHARGING_STATE.PAUSED_BY_CHARGER : CHARGING_STATE.EV_CONNECTED;
    case STATE.STANDBY:
    case STATE.LOCKED:
    case STATE.ERROR:
      return CHARGING_STATE.IDLE;
    default:
      return undefined;
  }
}

/** The text of the status feature. */
export function statusText(state, stopped) {
  if (state === STATE.CONNECTED && stopped === true) {
    return STOPPED;
  }
  return STATE_NAMES[state] ?? STATE_NAMES[STATE.UNKNOWN];
}

/** The name of a mode code ("Boost charging"), "Unknown mode" for another code. */
export const modeText = (mode) => MODE_NAMES[mode] ?? MODE_NAMES.other;

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;
const flag = (value) => (value === undefined ? undefined : value ? 1 : 0);

/**
 * The current values of the charger's device. Offline: only the status and
 * the connector (Gladys keeps the last value of the others). `index`: the
 * value of the energy index the guard lets through (undefined: none). A
 * value that is not a measure (a text, a code) never becomes a number here.
 */
export function deviceStates(ids, charger, { online, language, ceiling, index }) {
  if (!online) {
    return [
      { role: FEATURES.STATUS, text: word(STATE_NAMES[STATE.OFFLINE], language) },
      { role: FEATURES.CONNECTOR, state: CONNECTOR_STATUS.UNAVAILABLE },
    ].map(({ role, ...value }) => ({ device_feature_external_id: ids.feature(role), ...value }));
  }
  const states = [];
  // A value outside the bounds of its feature is dropped (Gladys keeps the last one).
  const add = (role, value) => {
    const { min, max } = DEFINITIONS[role];
    if (value !== undefined && Number.isFinite(value) && value >= min && value <= max) {
      states.push({ role, state: value });
    }
  };
  const m = charger.measures;
  const ctl = charger.control;
  const mode = ctl?.mode;
  const stopped = mode === undefined ? undefined : mode === MODES.STOP;
  if (m) {
    states.push({ role: FEATURES.STATUS, text: word(statusText(m.state, stopped), language) });
    add(FEATURES.CONNECTOR, connectorOf(m.state));
    add(FEATURES.CHARGING_STATE, chargingStateOf(m.state, stopped));
    if (m.state !== STATE.UNKNOWN && m.state !== STATE.ERROR && m.state !== STATE.LOCKED) {
      add(FEATURES.PLUGGED, PLUGGED_STATES.has(m.state) ? 1 : 0);
    }
    add(FEATURES.ERROR, flag(m.error));
    if (m.rotary) {
      states.push({ role: FEATURES.ROTARY, text: word(ROTARY_NAMES[m.rotary], language) });
    }
    if (m.health) {
      states.push({ role: FEATURES.HEALTH, text: word(HEALTH_NAMES[m.health], language) });
    }
    if (m.power !== undefined) add(FEATURES.POWER, Math.round(m.power));
    const phases = [
      [FEATURES.CURRENT_L1, FEATURES.VOLTAGE_L1],
      [FEATURES.CURRENT_L2, FEATURES.VOLTAGE_L2],
      [FEATURES.CURRENT_L3, FEATURES.VOLTAGE_L3],
    ];
    for (const [i, [currentRole, voltageRole]] of phases.entries()) {
      if (m.currents[i] !== undefined) add(currentRole, round(m.currents[i], 2));
      if (m.voltages[i] !== undefined) add(voltageRole, round(m.voltages[i], 1));
    }
    // The energy of the session restarts at each session: never 0 (the last
    // session stays shown until the new one has delivered something).
    if (m.sessionEnergy !== undefined && m.sessionEnergy > 0) {
      add(FEATURES.SESSION_ENERGY, round(m.sessionEnergy, 3));
    }
  }
  // Never 0, never a value the guard held back (src/app.js decides `index`).
  if (index !== undefined && index > 0) {
    add(FEATURES.ENERGY_INDEX, round(index, 3));
  }
  if (ctl) {
    if (mode !== undefined) {
      states.push({ role: FEATURES.MODE, text: word(modeText(mode), language) });
      add(FEATURES.STOPPED, flag(stopped));
      // The select shows the mode when it is one of its options.
      const option = Object.keys(MODE_OPTIONS).find((key) => MODE_OPTIONS[key] === mode);
      if (option) {
        states.push({ role: FEATURES.SET_MODE, text: option });
      }
    }
    if (ctl.currentLimit !== undefined) {
      add(FEATURES.CURRENT_LIMIT, round(ctl.currentLimit, 1));
      // The select shows the current set when it is one of its options.
      if (
        Number.isInteger(ctl.currentLimit) &&
        ctl.currentLimit >= CURRENT.min &&
        ctl.currentLimit <= ceiling
      ) {
        states.push({ role: FEATURES.SET_CURRENT, text: String(ctl.currentLimit) });
      }
    }
  }
  return states.map(({ role, ...value }) => ({
    device_feature_external_id: ids.feature(role),
    ...value,
  }));
}
