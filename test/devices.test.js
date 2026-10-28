// -----------------------------------------------------------------------------
// The device and its states (pure): the select options satisfy the core
// (it refuses the WHOLE publication when one option breaks its rules, and the
// SDK's fake Gladys never checks them), no switch, no text as a measure.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { CURRENT, FEATURES, STATE } from '../src/constants.js';
import { ROLES, buildDevice, chargerIds, deviceStates, parseFeatureId } from '../src/devices.js';

// The core's own validator, when a Gladys clone is at hand (not on GitHub CI).
const CORE_NORMALIZE = '/home/claude/code/Gladys/server/utils/normalizeSupportedOptions.js';
const normalizeSupportedOptions = existsSync(CORE_NORMALIZE)
  ? createRequire(import.meta.url)(CORE_NORMALIZE).normalizeSupportedOptions
  : undefined;

// The core's rules (server/utils/normalizeSupportedOptions.js), copied for the CI:
// a non-blank trimmed string label, an integer or (text/select only) a non-blank
// trimmed string value, an integer sort_order, no other key, no two values alike.
const OPTION_KEYS = ['id', 'value', 'label', 'sort_order'];
function checkOptions(options, where, allowStringValues) {
  assert.ok(Array.isArray(options) && options.length > 0, `${where}: options`);
  for (const [i, option] of options.entries()) {
    const at = `${where}[${i}]`;
    assert.equal(typeof option.label, 'string', `${at}.label must be a string`);
    assert.ok(option.label.trim().length > 0, `${at}.label is blank`);
    assert.equal(option.label, option.label.trim(), `${at}.label has surrounding whitespace`);
    assert.ok(
      Number.isInteger(option.value) ||
        (allowStringValues &&
          typeof option.value === 'string' &&
          option.value.length > 0 &&
          option.value === option.value.trim()),
      `${at}.value`,
    );
    assert.ok(option.sort_order === undefined || Number.isInteger(option.sort_order), at);
    assert.deepEqual(
      Object.keys(option).filter((k) => !OPTION_KEYS.includes(k)),
      [],
      `${at}: unknown key`,
    );
  }
  const values = options.map((o) => `${o.value}`);
  assert.equal(new Set(values).size, values.length, `${where}: duplicate values`);
  if (normalizeSupportedOptions) {
    normalizeSupportedOptions(options, { allowStringValues });
  }
}

const charger = {
  serial: '1234567890',
  control: { model: 'EVC22-3AC-10', firmware: '1.2.23.R', mode: '4718', currentLimit: 16 },
};

test('every published supported_options follows the rules of the core', () => {
  const gladys = createFakeGladys();
  for (const language of ['fr', 'en']) {
    for (const ceiling of [CURRENT.min, 16, CURRENT.max]) {
      const device = buildDevice(gladys, charger, { ceiling, language });
      const withOptions = device.features.filter((f) => f.supported_options !== undefined);
      assert.deepEqual(
        withOptions.map((f) => f.external_id.split(':').at(-1)),
        [FEATURES.SET_MODE, FEATURES.SET_CURRENT],
      );
      for (const f of withOptions) {
        checkOptions(
          f.supported_options,
          `${language}/${ceiling}/${f.external_id}`,
          f.category === DEVICE_FEATURE_CATEGORIES.TEXT &&
            f.type === DEVICE_FEATURE_TYPES.TEXT.SELECT,
        );
      }
    }
  }
});

test('no switch, no writable binary; commands are buttons and selects', () => {
  const device = buildDevice(createFakeGladys(), charger, { ceiling: 16, language: 'fr' });
  assert.equal(device.features.length, ROLES.length);
  for (const f of device.features) {
    assert.notEqual(f.category, DEVICE_FEATURE_CATEGORIES.SWITCH, f.external_id);
    if (f.type === DEVICE_FEATURE_TYPES.SENSOR.BINARY) assert.equal(f.read_only, true);
    if (!f.read_only) {
      assert.ok(
        [DEVICE_FEATURE_TYPES.BUTTON.PUSH, DEVICE_FEATURE_TYPES.TEXT.SELECT].includes(f.type),
        f.external_id,
      );
    }
  }
  assert.deepEqual(parseFeatureId(device.features[0].external_id), {
    serial: '1234567890',
    role: FEATURES.STATUS,
  });
});

test('states: never a text as a measure, never 0 for the energies, offline keeps the rest', () => {
  const ids = chargerIds(createFakeGladys(), '1234567890');
  const unknown = {
    measures: {
      state: STATE.UNKNOWN,
      currents: [undefined, undefined, undefined],
      voltages: [undefined, undefined, undefined],
      sessionEnergy: 0,
    },
    control: {},
  };
  const states = deviceStates(ids, unknown, {
    online: true,
    language: 'en',
    ceiling: 16,
    index: 0,
  });
  const roles = states.map((s) => s.device_feature_external_id.split(':').at(-1));
  for (const role of [
    'power',
    'energy-index',
    'session-energy',
    'plugged',
    'connector-status',
    'error',
  ]) {
    assert.ok(!roles.includes(role), role);
  }
  const offline = deviceStates(ids, unknown, { online: false, language: 'en', ceiling: 16 });
  assert.deepEqual(
    offline.map((s) => s.device_feature_external_id.split(':').at(-1)),
    ['status', 'connector-status'],
  );
});
