// -----------------------------------------------------------------------------
// /data (src/store.js): wall dates on disk, monotonic dates in memory,
// bounded when read back; no secret; a file that cannot be read is an error,
// never an empty state.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOUR, MINUTE, TIMINGS } from '../src/constants.js';
import { emptyMemory, fileStore, fromDisk, toDisk } from '../src/store.js';
import { FP } from './helpers/fakeSma.js';

const NOW = Date.UTC(2026, 9, 28, 10);
const clock = { mono: 1_000_000, now: NOW, session: NOW };

test('a round trip keeps every wait, bounded, as monotonic dates of the new life', () => {
  const memory = {
    ...emptyMemory(),
    target: '192.168.1.80',
    serial: '1234567890',
    pin: FP,
    pause: { until: clock.mono + 10 * MINUTE, reason: '5xx' },
    block: { failures: 2, refusedAt: clock.mono - MINUTE },
    stopWatch: {
      serial: '1234567890',
      sentAt: clock.mono - 10_000,
      until: clock.mono + 80_000,
      mayLand: true,
      confirmed: false,
      reasserts: 1,
    },
    lastReadAt: clock.mono - 5_000,
    lastChangeAt: clock.mono - 10_000,
    pendingStop: {
      serial: '1234567890',
      at: clock.mono - 1_000,
      from: '4718',
      changedReads: 1,
      notBefore: -Infinity,
      sent: 1,
    },
  };
  const disk = toDisk(memory, clock);
  assert.equal(disk.pause.until, NOW + 10 * MINUTE);
  // A new life: its monotonic clock starts near 0, 2 minutes later.
  const later = { mono: 50, now: NOW + 2 * MINUTE, session: NOW + 2 * MINUTE };
  const back = fromDisk(JSON.parse(JSON.stringify(disk)), later);
  assert.equal(back.pause.until, 50 + 8 * MINUTE);
  assert.equal(back.block.refusedAt, 50 - 3 * MINUTE);
  // The watch of the stop: 80 s left then, the 2 minutes since spent it.
  assert.equal(back.stopWatch, null);
  const soon = fromDisk(JSON.parse(JSON.stringify(disk)), {
    mono: 50,
    now: NOW + 10_000,
    session: NOW,
  });
  assert.equal(soon.stopWatch.until, 50 + 70_000);
  assert.equal(soon.stopWatch.reasserts, 1);
  assert.equal(back.lastReadAt, 50 - 2 * MINUTE - 5_000);
  assert.equal(back.pendingStop.sent, 1);
  assert.equal(back.pendingStop.from, '4718');
  assert.equal(back.pendingStop.notBefore, -Infinity);
  assert.equal(back.pin, FP);
});

test('dates in the future (a wall clock set back) are bounded; a stop clicked in the future is dropped', () => {
  const disk = {
    target: '192.168.1.80',
    pause: { until: NOW + 100 * HOUR, reason: '429' },
    block: { failures: 1, refusedAt: NOW + HOUR },
    lastReadAt: NOW + HOUR,
    lastChangeAt: NOW + HOUR,
    unconfirmedStartUntil: NOW + HOUR,
    pendingStop: { serial: '1234567890', at: NOW + MINUTE, sent: 0 },
  };
  const m = fromDisk(disk, clock);
  assert.equal(m.pause.until, clock.mono + TIMINGS.rateLimitMax);
  assert.equal(m.block.refusedAt, clock.mono);
  assert.equal(m.lastReadAt, clock.mono);
  assert.equal(m.lastChangeAt, clock.mono);
  assert.equal(m.unconfirmedStartUntil, clock.mono + TIMINGS.guard);
  assert.equal(m.pendingStop, null);
});

test('a broken file is an error, a missing one is empty', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sma-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.equal(await store.load(), null);
  await writeFile(path, '{not json');
  await assert.rejects(store.load());
  await store.save({ a: 1 });
  assert.deepEqual(await store.load(), { a: 1 });
});

test('index ids of /data need a ":" (never __proto__)', () => {
  const raw = JSON.parse(
    '{"target":"1.2.3.4","indexes":{"__proto__":{"last":{"value":1,"at":1}},"ext:x:sma:1:energy-index":{"last":{"value":5,"at":1}}}}',
  );
  const m = fromDisk(raw, clock);
  assert.deepEqual(Object.keys(m.indexes), ['ext:x:sma:1:energy-index']);
  assert.equal(Object.getPrototypeOf(m.indexes), Object.prototype);
});
