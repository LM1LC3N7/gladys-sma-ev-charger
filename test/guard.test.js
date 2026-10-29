// -----------------------------------------------------------------------------
// The index guard, taken from gladys-p1-monitor with its tests: the same
// numbers with the same limits (100 kW, 0.5 kWh), plus the limits as a
// parameter.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexGuard } from '../src/guard.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const LIMITS = { maxKw: 100, slackKwh: 0.5 };
const guardOf = (last, saved, loadedAt) => new IndexGuard(last, saved, loadedAt, LIMITS);

test('index guard: the limits are required and used', () => {
  assert.throws(() => new IndexGuard(), /maxKw/);
  assert.throws(() => new IndexGuard(undefined, undefined, 0, { maxKw: 0, slackKwh: 0 }), /maxKw/);
  // 36 kW for an hour + 0.5: 36.5 kWh at most.
  const small = new IndexGuard({ value: 100, at: 0 }, undefined, 0, { maxKw: 36, slackKwh: 0.5 });
  assert.equal(small.accept(136.6, 60 * MINUTE), false);
  const fair = new IndexGuard({ value: 100, at: 0 }, undefined, 0, { maxKw: 36, slackKwh: 0.5 });
  assert.equal(fair.accept(136.4, 60 * MINUTE), true);
});

test('index guard: never 0, a normal rise goes through', () => {
  const guard = guardOf();
  assert.equal(guard.accept(0, 0), false, 'never 0, even as the first reference');
  assert.equal(guard.accept(1000, 0), true);
  assert.equal(guard.accept(1000.2, MINUTE), true);
  for (let i = 2; i < 200; i += 1) {
    assert.equal(guard.accept(0, i * MINUTE), false);
  }
  assert.equal(guard.accept(1000.3, 200 * MINUTE), true);
  assert.equal(guardOf().accept(-1, 0), false);
  assert.equal(guardOf().accept(NaN, 0), false);
  assert.equal(guardOf({ value: 100, at: 0 }).accept(400, 24 * 60 * MINUTE), true);
});

test('index guard: a jump up is never confirmed by repetition, only by the user', () => {
  const guard = guardOf({ value: 1000, at: 0 });
  for (let i = 1; i <= 500; i += 1) {
    assert.equal(guard.accept(6000 + i * 0.01, i * MINUTE), false);
  }
  assert.deepEqual(guard.held, {
    direction: 'up',
    from: 1000,
    to: 6005,
    threshold: 6000.01,
    at: 500 * MINUTE,
  });
  assert.deepEqual(guard.acceptHeld(), { direction: 'up', from: 1000, to: 6005 });
  assert.equal(guard.accept(6005.01, 501 * MINUTE), true);
  assert.equal(guard.held, undefined);
  const back = guardOf({ value: 1000, at: 0 });
  back.accept(9000, MINUTE);
  assert.equal(back.accept(1000.1, 2 * MINUTE), true);
  assert.equal(back.held, undefined);
  back.acceptHeld();
  assert.equal(back.accept(9000, 3 * MINUTE), false, 'an old acceptance never covers a new jump');
});

test('index guard: a held jump is never covered by the margin growing over time', () => {
  const guard = guardOf({ value: 2.5, at: 0 });
  assert.equal(guard.accept(12345, MINUTE), false);
  assert.equal(guard.accept(12345.5, 200 * 60 * MINUTE), false);
  assert.deepEqual(guard.held, {
    direction: 'up',
    from: 2.5,
    to: 12345.5,
    threshold: 12345,
    at: 200 * 60 * MINUTE,
  });
  assert.equal(guard.accept(2.6, 200 * 60 * MINUTE + MINUTE), true);
});

test('index guard: a drop is never confirmed by time; back up, nothing fictive is counted', () => {
  const guard = guardOf({ value: 50_000, at: 0 });
  for (let i = 1; i <= 7 * 24 * 60; i += 60) {
    assert.equal(guard.accept(10 + i * 0.0001, i * MINUTE), false, `minute ${i}`);
  }
  assert.equal(guard.held.direction, 'down');
  assert.deepEqual(guard.last, { value: 50_000, at: 0 });
  assert.equal(guard.accept(50_001, 7 * 24 * 60 * MINUTE + MINUTE), true);
  assert.equal(guard.held, undefined);
});

test('index guard: a drop accepted by the user, then the values rise normally', () => {
  const guard = guardOf({ value: 50_000, at: 0 });
  assert.equal(guard.accept(10, MINUTE), false);
  guard.acceptHeld();
  assert.equal(guard.accept(10.01, 2 * MINUTE), true);
  assert.deepEqual(guard.last, { value: 10.01, at: 2 * MINUTE });
  assert.equal(guard.accept(10.5, 3 * MINUTE), true);
  assert.equal(guard.accept(50_000, 4 * MINUTE), false);
  assert.equal(guard.held.direction, 'up');
});

test('index guard: an acceptance of a drop never takes a jump', () => {
  const guard = guardOf({ value: 1000, at: 0 });
  guard.accept(10, MINUTE);
  guard.acceptHeld();
  assert.equal(guard.accept(90_000, 2 * MINUTE), false);
  assert.equal(guard.held.direction, 'up');
  assert.equal(guard.accept(90_000, 3 * MINUTE), false);
});

test('index guard: a frozen reading never shrinks the margin of the next rise', () => {
  const guard = guardOf({ value: 1000, at: 0 });
  for (let i = 1; i <= 180; i += 1) {
    assert.equal(guard.accept(1000, i * MINUTE), true);
  }
  assert.deepEqual(guard.last, { value: 1000, at: 0 }, 'the date of the value is kept');
  assert.equal(guard.accept(1004, 181 * MINUTE), true);
  assert.equal(guard.held, undefined);
});

test('index guard: its state survives a restart; same value, the oldest date', () => {
  const guard = guardOf({ value: 1000, at: 0 });
  guard.accept(1050, MINUTE);
  const saved = JSON.parse(JSON.stringify(guard.state()));
  const again = guardOf({ value: 900, at: -1000 * MINUTE }, saved);
  assert.deepEqual(again.last, { value: 1000, at: 0 });
  assert.equal(again.accept(1050.1, 60 * MINUTE), false, 'still held after the restart');
  again.acceptHeld();
  assert.equal(again.accept(1050.2, 61 * MINUTE), true);
  assert.deepEqual(guardOf({ value: 1100, at: 5 }, saved).last, { value: 1100, at: 5 });
  assert.deepEqual(guardOf({ value: 1000, at: 50 }, saved).last, { value: 1000, at: 0 });
  assert.deepEqual(guardOf({ value: 1000, at: -50 }, { last: { value: 1000, at: 10 } }).last, {
    value: 1000,
    at: -50,
  });
});

test('index guard: an acceptance is bounded to the value shown and the margin since', () => {
  const guard = guardOf({ value: 1000, at: 0 });
  assert.equal(guard.accept(1005, MINUTE), false);
  assert.deepEqual(guard.acceptHeld(), { direction: 'up', from: 1000, to: 1005 });
  assert.equal(guard.accept(5000, 2 * MINUTE), false);
  assert.deepEqual(guard.last, { value: 1000, at: 0 });
  assert.equal(guard.held.to, 5000);
  assert.equal(guard.accepted, undefined);
  assert.equal(guard.accept(5000.1, 3 * MINUTE), false, 'still held');
  const fair = guardOf({ value: 1000, at: 0 });
  fair.accept(1005, MINUTE);
  fair.acceptHeld();
  assert.equal(fair.accept(1005.5, 2 * MINUTE), true);
  const below = guardOf({ value: 1000, at: 0 });
  below.accept(1005, MINUTE);
  below.acceptHeld();
  assert.equal(below.accept(1004, 2 * MINUTE), false);
  const drop = guardOf({ value: 1000, at: 0 });
  drop.accept(10, MINUTE);
  drop.acceptHeld();
  assert.equal(drop.accept(900, 2 * MINUTE), false, 'not the drop shown');
  drop.accept(10, 3 * MINUTE);
  drop.acceptHeld();
  assert.equal(drop.accept(10.2, 4 * MINUTE), true);
  assert.equal(guardOf({ value: 1, at: 0 }).acceptHeld(), undefined, 'nothing held');
});

test('index guard: a value held read back from /data is dated at its loading', () => {
  const saved = {
    last: { value: 1000, at: 0 },
    held: { direction: 'up', from: 1000, to: 1005, threshold: 1005, at: 0 },
  };
  const guard = guardOf(undefined, saved, 5 * DAY);
  assert.equal(guard.held.at, 5 * DAY);
  guard.acceptHeld();
  assert.equal(guard.accept(5000, 5 * DAY + MINUTE), false, 'the old date never widens it');
  assert.equal(guard.held.to, 5000);
  const fair = guardOf(undefined, saved, 5 * DAY);
  fair.acceptHeld();
  assert.equal(fair.accept(1005.5, 5 * DAY + MINUTE), true);
});

test('index guard: under a held jump, an old reference never lets a big rise through', () => {
  const guard = guardOf({ value: 1000, at: 0 });
  assert.equal(guard.accept(15_000, MINUTE), false);
  assert.equal(guard.accept(15_000, 10 * DAY), false);
  assert.equal(guard.held.threshold, 15_000);
  assert.equal(guard.accept(14_000, 10 * DAY + MINUTE), false);
  assert.deepEqual(guard.last, { value: 1000, at: 0 });
  assert.equal(guard.held.to, 14_000);
  assert.equal(guard.held.from, 1000);
  assert.equal(guard.accept(1000.2, 10 * DAY + 2 * MINUTE), true);
  assert.equal(guard.held, undefined);
});

test('index guard: readings under an accepted floor for hours never widen the acceptance (r2, I4)', () => {
  const guard = new IndexGuard({ value: 855.287, at: 0 }, undefined, 0, {
    maxKw: 60,
    slackKwh: 0.5,
  });
  assert.equal(guard.accept(12, MINUTE), false);
  assert.ok(guard.acceptHeld());
  let t = 2 * MINUTE;
  for (; t < 15 * 60 * MINUTE; t += MINUTE) assert.equal(guard.accept(5, t), false);
  assert.equal(guard.accept(900, t), false, '900 kWh after 15 h under the floor: held');
  // A value above the acceptance dropped it: 12.1 needs a new acceptance.
  assert.equal(guard.accept(12.1, t + MINUTE), false);
  assert.equal(guard.held.direction, 'down');
});

test('index guard: a value under the accepted floor is held, the acceptance kept for the value listed (r3)', () => {
  const guard = guardOf({ value: 1000, at: 0 });
  assert.equal(guard.accept(10, MINUTE), false);
  assert.ok(guard.acceptHeld());
  // The read of the click had no meter reading: the next one, under the floor.
  assert.equal(guard.accept(9.5, 2 * MINUTE), false);
  assert.deepEqual([guard.held.direction, guard.held.to], ['down', 9.5]);
  assert.equal(guard.accepted.to, 10);
  // The value accepted comes back: taken, without a new click.
  assert.equal(guard.accept(10.2, 3 * MINUTE), true);
  assert.deepEqual(guard.last, { value: 10.2, at: 3 * MINUTE });
  assert.equal(guard.held, undefined);
});
