// -----------------------------------------------------------------------------
// The parsers of the SMA answers (pure), on the fixtures of ha-sma-ev-charger
// (Apache-2.0, tests/fixtures: an EVC22-3AC-10 as Home Assistant reads it)
// and on hostile answers: wrong shapes, other components, texts where a
// number is expected, prototype keys.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MODES, STATE } from '../src/constants.js';
import {
  controlOf,
  measuresOf,
  numberOf,
  parseMeasurements,
  parseParameters,
  retryAfterOf,
  serialOf,
} from '../src/sma/client.js';
import { ERROR_KINDS } from '../src/sma/http.js';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

test('the measurements of the Home Assistant fixture', () => {
  const m = measuresOf(parseMeasurements(fixture('measurements')));
  assert.equal(m.state, STATE.CONNECTED);
  assert.equal(m.health, 'ok');
  assert.equal(m.rotary, 'boost');
  assert.equal(m.power, 0);
  assert.equal(m.totalEnergy, 875.891);
  assert.equal(m.sessionEnergy, 8.127);
  assert.deepEqual(m.currents, [0, 0, 0]);
  assert.deepEqual(m.voltages, [233.20000000000002, 230.9, 233]);
  assert.equal(m.error, false);
});

test('the parameters of the Home Assistant fixture', () => {
  const c = controlOf(parseParameters(fixture('parameters')));
  assert.equal(c.serial, '1234567890');
  assert.equal(c.model, 'EVC22-3AC-10');
  assert.equal(c.firmware, '1.2.23.R');
  assert.equal(c.vendor, '461');
  assert.equal(c.mode, MODES.STOP);
  assert.deepEqual(c.possibleModes, ['4718', '4721']);
  assert.equal(c.currentLimit, 16);
  assert.equal(c.limitMin, 6);
  assert.equal(c.limitMax, 32);
  assert.equal(c.rated, 32);
});

test('hostile answers: shapes, other components, texts, prototype keys', () => {
  assert.throws(
    () => parseMeasurements({}),
    (e) => e.kind === ERROR_KINDS.PROTOCOL,
  );
  assert.throws(
    () => parseParameters([{ componentId: 'Other' }]),
    (e) => e.kind === ERROR_KINDS.PROTOCOL,
  );
  const m = parseMeasurements(
    JSON.parse(
      '[{"channelId":"Measurement.Metering.GridMs.TotWhIn.ChaSta","componentId":"Other:1","values":[{"value":5}]},' +
        '{"channelId":"Measurement.Metering.GridMs.TotWIn.ChaSta","componentId":"IGULD:SELF","values":[{"value":"Aus"}]},' +
        '{"channelId":"Measurement.Operation.EVeh.ChaStt","componentId":"IGULD:SELF","values":[{"value":123}]},' +
        '{"__proto__":{"polluted":1},"channelId":"Measurement.ChaSess.WhIn","componentId":"IGULD:SELF","values":[{}]}]',
    ),
  );
  assert.equal(m.size, 1);
  const measures = measuresOf(m);
  // A text is never a measure 0; an unknown code is an unknown state.
  assert.equal(measures.power, undefined);
  assert.equal(measures.totalEnergy, undefined);
  assert.equal(measures.sessionEnergy, undefined);
  assert.equal(measures.state, STATE.UNKNOWN);
  assert.equal(measures.error, undefined);
  assert.equal({}.polluted, undefined);
  const p = controlOf(
    parseParameters([
      {
        componentId: 'IGULD:SELF',
        values: [
          { channelId: 'Parameter.Inverter.AcALim', value: '', min: '6', max: 32 },
          { channelId: 'Parameter.Chrg.ActChaMod', value: '9999', possibleValues: ['4718', 4721] },
          { channelId: 'Parameter.Nameplate.SerNum', value: '../../x' },
        ],
      },
    ]),
  );
  assert.equal(p.currentLimit, undefined, "'' is unknown, never 0");
  assert.equal(p.limitMin, undefined);
  assert.equal(p.mode, 'other');
  assert.equal(p.possibleModes, undefined);
  assert.equal(p.serial, undefined);
});

test('numbers and serials are strict', () => {
  assert.equal(numberOf(''), undefined);
  assert.equal(numberOf(' 16'), undefined);
  assert.equal(numberOf('16.000'), 16);
  assert.equal(numberOf(null), undefined);
  assert.equal(numberOf(Infinity), undefined);
  assert.equal(serialOf('ABC123'), 'abc123');
  assert.equal(serialOf('ab'), undefined);
  assert.equal(serialOf('a:b:c'), undefined);
});

test('Retry-After: seconds, or a date against the Date header of the answer only', () => {
  assert.equal(retryAfterOf({ 'retry-after': '120' }), 120_000);
  assert.equal(retryAfterOf({ 'retry-after': 'Wed, 28 Oct 2026 10:05:00 GMT' }), undefined);
  assert.equal(
    retryAfterOf({
      'retry-after': 'Wed, 28 Oct 2026 10:05:00 GMT',
      date: 'Wed, 28 Oct 2026 10:00:00 GMT',
    }),
    300_000,
  );
});
