// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container):
//   - the end of a pause (429, or a 5xx) and the block after refused
//     credentials, so a restart never asks the charger again before its time
//     and never loops on a refused login;
//   - the time of the last read (written at most once a minute), so a
//     restart never reads the charger sooner than the interval;
//   - the address read last, the serial number of the charger there (not a
//     secret: the id of the device), so that "Stop charging" goes before the
//     first read after a restart, and the SHA-256 fingerprint of its
//     certificate (the pin: not a secret either, the certificate is public),
//     plus the one last refused, for "Trust the new certificate";
//   - a stop not sent yet (sent again before the next reads), the minute
//     between two changes and the watch of a start left without
//     confirmation;
//   - the guard of the energy index (its reference and a value held back).
// NO SECRET: neither the user name, nor the password, nor anything derived
// from them (not even a hash), nor the access token. The file is readable by
// the container user only (0600).
//
// Clocks: in memory every date is MONOTONIC (the decisions never read the
// wall clock), but a monotonic instant belongs to its process, so /data
// holds wall dates: `toDisk` turns them into wall dates with the offset of
// now, `fromDisk` back into monotonic dates of this process, bounded (a date
// "in the future" after a wall clock set back is never a longer wait than
// its maximum). The index guard works on the session clock (wall at the
// start of the process + monotonic since): its dates go the same way.
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { normalizeFingerprint } from './sma/http.js';
import { LIMITS, TIMINGS } from './constants.js';

export const STATE_FILE = '/data/sma-ev-charger-state.json';

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      const text = await readFile(path, 'utf8').catch((err) => {
        if (err?.code === 'ENOENT') return null;
        throw err;
      });
      if (text === null) return null;
      if (text.length > 256 * 1024) throw new Error('state file too large');
      return JSON.parse(text);
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    failSave: false,
    failLoad: false,
    async load() {
      if (this.failLoad) throw new Error('EIO');
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      if (this.failSave) throw Object.assign(new Error('read-only'), { code: 'EROFS' });
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const FEATURE_ID = /^[a-z0-9_-]{1,60}(?::[a-z0-9_-]{1,60}){1,6}$/;
const SERIAL = /^[0-9a-z](?:[0-9a-z_-]{2,38}[0-9a-z])$/;
const TARGET = /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** The empty state (monotonic dates). */
export const emptyMemory = () => ({
  target: null,
  serial: null,
  pin: null,
  refusedPin: null,
  pause: null,
  block: null,
  lastReadAt: -Infinity,
  lastChangeAt: -Infinity,
  unconfirmedStartUntil: -Infinity,
  pendingStop: null,
  /** A stop given up after 3 identical refusals: { serial, status }, shown until a read 4721 or a click. */
  stopGivenUp: null,
  /** The 90 s watch after a stop: { serial, sentAt, until, mayLand, confirmed, reasserts }. */
  stopWatch: null,
  indexes: {},
});

/**
 * The state as /data keeps it: monotonic dates turned into wall dates
 * (`clock`: `{ mono, now, session }` read once by the caller), session dates
 * of the guards too. -Infinity is written as null.
 */
export function toDisk(memory, { mono, now, session }) {
  const wall = (m) => (finite(m) ? Math.round(now + (m - mono)) : null);
  const offset = now - session;
  const point = (p) => (p && finite(p.at) ? { ...p, at: Math.round(p.at + offset) } : (p ?? null));
  return {
    target: memory.target,
    serial: memory.serial,
    pin: memory.pin,
    refusedPin: memory.refusedPin,
    pause: memory.pause ? { until: wall(memory.pause.until), reason: memory.pause.reason } : null,
    block: memory.block
      ? { failures: memory.block.failures, refusedAt: wall(memory.block.refusedAt) }
      : null,
    lastReadAt: wall(memory.lastReadAt),
    lastChangeAt: wall(memory.lastChangeAt),
    unconfirmedStartUntil: wall(memory.unconfirmedStartUntil),
    pendingStop: memory.pendingStop
      ? {
          serial: memory.pendingStop.serial,
          at: wall(memory.pendingStop.at),
          from: memory.pendingStop.from,
          changedReads: memory.pendingStop.changedReads,
          notBefore: wall(memory.pendingStop.notBefore),
          sent: memory.pendingStop.sent,
          rights: memory.pendingStop.rights,
          refusal: memory.pendingStop.refusal,
        }
      : null,
    stopGivenUp: memory.stopGivenUp ?? null,
    stopWatch: memory.stopWatch
      ? {
          ...memory.stopWatch,
          sentAt: wall(memory.stopWatch.sentAt),
          until: wall(memory.stopWatch.until),
        }
      : null,
    indexes: Object.fromEntries(
      Object.entries(memory.indexes).map(([id, s]) => [
        id,
        { last: point(s.last), held: point(s.held) },
      ]),
    ),
  };
}

const pointOf = (p) =>
  plain(p) && finite(p.value) && p.value > 0 && finite(p.at) ? { value: p.value, at: p.at } : null;

const heldOf = (h) =>
  plain(h) &&
  (h.direction === 'up' || h.direction === 'down') &&
  [h.from, h.to, h.threshold, h.at].every(finite)
    ? { direction: h.direction, from: h.from, to: h.to, threshold: h.threshold, at: h.at }
    : null;

/**
 * The state read from /data, repaired, bounded and turned into monotonic
 * dates of this process (`clock`: `{ mono, now, session }`). A date in the
 * future where only the past makes sense (a wall clock set back) is now; a
 * wait is never longer than its maximum from now.
 */
export function fromDisk(raw, { mono, now, session }) {
  const data = plain(raw) ? raw : {};
  const memory = emptyMemory();
  // A wall date as a monotonic one, at most `max` ms ahead (Infinity: no bound).
  const ahead = (w, max) => (finite(w) ? mono + Math.min(w - now, max) : -Infinity);
  const past = (w) => ahead(w, 0);
  const target = typeof data.target === 'string' && TARGET.test(data.target) ? data.target : null;
  memory.target = target;
  if (target) {
    memory.serial =
      typeof data.serial === 'string' && SERIAL.test(data.serial) ? data.serial : null;
    memory.pin = normalizeFingerprint(data.pin) ?? null;
    memory.refusedPin = normalizeFingerprint(data.refusedPin) ?? null;
    memory.lastReadAt = past(data.lastReadAt);
  }
  const pause = plain(data.pause) ? data.pause : {};
  if (finite(pause.until) && pause.until > now) {
    memory.pause = {
      until: ahead(pause.until, TIMINGS.rateLimitMax),
      reason: pause.reason === '5xx' ? '5xx' : '429',
    };
  }
  const block = plain(data.block) ? data.block : undefined;
  if (block) {
    const failures = Number.isInteger(block.failures) && block.failures > 0 ? block.failures : 1;
    memory.block = {
      failures: Math.min(failures, 100),
      /** When a login was last refused (a stop or the button during a block never loops). */
      refusedAt: past(block.refusedAt),
    };
  }
  memory.lastChangeAt = past(data.lastChangeAt);
  memory.unconfirmedStartUntil = ahead(data.unconfirmedStartUntil, TIMINGS.guard);
  const stop = plain(data.pendingStop) ? data.pendingStop : undefined;
  // A stop clicked "in the future" (a wall clock set back) is not valid:
  // dropped. Never dropped for its age: only a read, a newer click or a
  // change read twice elsewhere lift it (src/app.js).
  const count = (v) => (Number.isInteger(v) && v >= 0 ? Math.min(v, 1000) : 0);
  if (
    stop &&
    typeof stop.serial === 'string' &&
    SERIAL.test(stop.serial) &&
    finite(stop.at) &&
    stop.at <= now
  ) {
    memory.pendingStop = {
      serial: stop.serial,
      at: past(stop.at),
      /** The mode read before the click (null: unknown, never "changed elsewhere"). */
      from: typeof stop.from === 'string' && /^\d{1,8}$/.test(stop.from) ? stop.from : null,
      changedReads: Math.min(count(stop.changedReads), 1),
      notBefore: ahead(stop.notBefore, TIMINGS.pendingStopWaitMax),
      sent: count(stop.sent),
      rights: stop.rights === true,
      refusal:
        plain(stop.refusal) &&
        Number.isInteger(stop.refusal.status) &&
        stop.refusal.status >= 400 &&
        stop.refusal.status < 500
          ? { status: stop.refusal.status, count: Math.min(count(stop.refusal.count), 10) }
          : null,
    };
  }
  const givenUp = plain(data.stopGivenUp) ? data.stopGivenUp : undefined;
  if (
    givenUp &&
    typeof givenUp.serial === 'string' &&
    SERIAL.test(givenUp.serial) &&
    Number.isInteger(givenUp.status)
  ) {
    memory.stopGivenUp = { serial: givenUp.serial, status: givenUp.status };
  }
  const watch = plain(data.stopWatch) ? data.stopWatch : undefined;
  if (
    watch &&
    typeof watch.serial === 'string' &&
    SERIAL.test(watch.serial) &&
    finite(watch.sentAt) &&
    finite(watch.until) &&
    watch.until > now &&
    Number.isInteger(watch.reasserts) &&
    watch.reasserts >= 0
  ) {
    memory.stopWatch = {
      serial: watch.serial,
      sentAt: past(watch.sentAt),
      until: ahead(watch.until, TIMINGS.guard),
      mayLand: watch.mayLand === true,
      confirmed: watch.confirmed === true,
      reasserts: Math.min(watch.reasserts, TIMINGS.stopReasserts),
    };
  }
  // The guards: wall dates -> session dates, never after the session clock now.
  const offset = now - session;
  const toSession = (p) => (p ? { ...p, at: Math.min(p.at - offset, session) } : null);
  if (plain(data.indexes)) {
    for (const [id, state] of Object.entries(data.indexes).slice(0, LIMITS.indexStates)) {
      if (FEATURE_ID.test(id) && plain(state)) {
        memory.indexes[id] = {
          last: toSession(pointOf(state.last)),
          held: toSession(heldOf(state.held)),
        };
      }
    }
  }
  return memory;
}
