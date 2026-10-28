// -----------------------------------------------------------------------------
// The integration: the SMA EV Charger typed in the configuration (one
// address, its user name and password), read every poll interval, its Gladys
// device and states, the guard of its energy index, the transport badge, the
// "Test the connection", "Accept the held index" and "Trust the new
// certificate" buttons, and the four commands (stop, start, charging mode,
// charging current). index.js only wires the SDK handlers to it.
//
// One session at a time on the charger: a poll, a command or a stop each
// open their own session (an access token asked when the one in memory is
// old, then the reads or the write, each request on its own connection whose
// certificate is checked against the pin first); a command takes the charger
// from a poll under way, a stop takes it from anything (the session given up
// is closed at once, its read never applied).
//
// Clocks: every decision (interval, pauses, blocks, deadlines, guards, the
// minute between two changes, the two clicks) is taken on the MONOTONIC clock
// (`this.mono`), read once per decision; the wall clock only dates what /data
// keeps (src/store.js) and the timestamp the charger wants with a written
// value. The energy index guard runs on the SESSION clock: the wall clock read
// once at the start of the process plus the monotonic time since, so that NTP
// moving the wall clock never widens nor narrows its margin.
//
// Commands follow the rules learnt on the previous modules (gladys-alfen,
// gladys-peblar, gladys-nrgkick, gladys-openevse):
//   - "Stop charging" (and the mode "Charge stop" of the select) is
//     protective: it needs no option and is never held back: not by a
//     command in flight (it takes the charger at once), not by the minute
//     between two changes, not by a 429/5xx pause, not by refused
//     credentials (one login at most every 5 minutes: a refused password
//     never loops), not by a failed read (it needs none), not before the
//     first read after a restart (the serial is kept in /data), not by a
//     /data that cannot be written. Not sent (unreachable), it is tried again
//     within its budget, then kept in /data and sent again before the next
//     reads (3 times within 15 minutes). A stop contradicted by a read (the
//     charger still not stopped, or a start of Gladys that may land after it)
//     is sent again, twice at most;
//   - "Start charging", the other modes and the charging current stay behind
//     an option (off by default), checked on arrival and again right before
//     sending; they are decided on a fresh read in the same session, never
//     on the state kept in memory, and refused when a value they need is
//     missing; one of them a minute (kept in /data before the first byte);
//     the current capped by the configured ceiling, the maximum of the
//     charger and its rated current;
//   - sent within 3.5 s of the click (token and reads included) or refused
//     unsent; answered by 4.3 s; checked again right before the bytes go;
//   - a command that may have reached the charger (silence, a 5xx) is never
//     answered "not sent": "sent, without confirmation", then spaced reads;
//     a command is confirmed only by a read showing the value asked;
//   - the ack never waits for a publication to Gladys;
//   - a read that began before the last command was sent may show the state
//     before it: quarantined, never applied nor published.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { SmaClient, controlOf, errorReason, measuresOf, timestampOf } from './sma/client.js';
import { ChargerError, ERROR_KINDS, notSent } from './sma/http.js';
import { addressKey, credentialsKey, normalizeConfig, targetKey } from './config.js';
import {
  CURRENT,
  FEATURES,
  GUARD_LIMITS,
  LIMITS,
  MODES,
  MODE_OPTIONS,
  PARAMS,
  PLUGGED_STATES,
  PRESSED,
  SECOND,
  STATE,
  TIMINGS,
} from './constants.js';
import {
  COMMAND_ROLES,
  buildDevice,
  chargerIds,
  deviceName,
  deviceStates,
  modeText,
  parseDeviceId,
  parseFeatureId,
  statusText,
} from './devices.js';
import { IndexGuard } from './guard.js';
import { ERRORS, MODE_NAMES, STATE_NAMES, T, age, summaryOf, word } from './i18n.js';
import { StatePublisher } from './publisher.js';
import { emptyMemory, fileStore, fromDisk, toDisk } from './store.js';

const both = (en, fr) => ({ en, fr });
const join = (a, b) => both(`${a.en} ${b.en}`, `${a.fr} ${b.fr}`);
const round3 = (value) => Math.round(value * 1000) / 1000;

/** The key of a value held back: what it is, not where it is now (`to` moves). */
export const holdKey = (held) =>
  held.direction === 'down' ? `down:${held.from}` : `up:${held.from}:${held.threshold}`;

/** The last value Gladys holds for a feature (`{ value, at }`, wall date), from its devices. */
function lastValueOf(devices, featureId) {
  for (const device of devices ?? []) {
    const feature = (device?.features ?? []).find((f) => f.external_id === featureId);
    if (feature) {
      const value = Number(feature.last_value);
      const at = Date.parse(feature.last_value_changed ?? '');
      return feature.last_value !== null &&
        feature.last_value !== undefined &&
        feature.last_value !== '' &&
        Number.isFinite(value) &&
        Number.isFinite(at)
        ? { value, at }
        : undefined;
    }
  }
  return undefined;
}

const freshCharger = () => ({
  serial: undefined,
  measures: undefined,
  control: undefined,
  /** The energy index the guard lets through (undefined: none to publish). */
  index: undefined,
  online: undefined,
  failures: 0,
  wait: undefined,
  error: undefined,
  timer: undefined,
  running: undefined,
  followUps: new Set(),
  /** When the last request that writes left, resends included (a read begun before it is quarantined). */
  lastSentAt: -Infinity,
  /** When the last start (a mode other than "Charge stop") left: only a start undoes a stop. */
  lastStartAt: -Infinity,
});

const SESSION = { POLL: 'poll', COMMAND: 'command', STOP: 'stop' };

/** Whether a command role and value is a stop (protective). */
const isStopCommand = (role, wanted) =>
  role === FEATURES.STOP || (role === FEATURES.SET_MODE && wanted === 'stop');

const sleep = (timers, ms) => new Promise((resolve) => timers.setTimeout(resolve, ms));

export class SmaApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'sma-ev-charger' }),
    exchange,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.mono = monotonic;
    /** The session clock: wall at the start of the process + monotonic elapsed since. */
    this.wallStart = now();
    this.monoStart = monotonic();
    this.timers = timers;
    this.store = store;
    this.client = new SmaClient(exchange ? { exchange } : {});
    this.publisher = new StatePublisher({ gladys, logger, monotonic, timers });
    /** undefined until a configuration was read from Gladys. */
    this.config = undefined;
    this.memory = emptyMemory();
    this.loaded = false;
    this.storageBroken = false;
    this.savedKey = undefined;
    this.charger = freshCharger();
    this.generation = 0;
    this.started = false;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    /** The exact start of the last read (monotonic); /data keeps it at most once a minute. */
    this.lastReadAt = -Infinity;
    /** The session open on the charger: { kind, connection, aborted, done }. */
    this.session = undefined;
    /** The access token of the charger: memory only, never logged nor stored. */
    this.token = undefined;
    /** The command in flight: { role, startLike, sentAt, overtaken, promise, settled }. */
    this.inFlight = undefined;
    /** `${serial}:mode` / `${serial}:current` -> a command sent, not seen yet. */
    this.guards = new Map();
    /** featureId -> IndexGuard (the energy index of a created device). */
    this.indexGuards = new Map();
    /** The first click of "Accept the held index" / "Trust the new certificate". */
    this.pendingAccept = undefined;
    this.pendingTrust = undefined;
    /** The hold last logged (a hold is logged once). */
    this.loggedHold = undefined;
    /** Start, stop and configuration changes, one after the other (the last one wins). */
    this.lifecycle = Promise.resolve();
    this.configAttempt = 0;
    this.configFailures = 0;
    this.configTimer = undefined;
    this.configRetryWait = undefined;
  }

  /** The session clock (ms since epoch): never moved by a wall clock set by NTP. */
  sessionNow() {
    return this.wallStart + (this.mono() - this.monoStart);
  }

  /** The three clocks read once, for /data. */
  clock() {
    return { mono: this.mono(), now: this.now(), session: this.sessionNow() };
  }

  // --- Lifecycle -------------------------------------------------------------

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  /**
   * `connected` (the first connection and each reconnection): the
   * configuration asked from Gladys, again and again while it fails (5 s,
   * 15 s, 30 s, then every minute, without end). Meanwhile the configuration
   * read before (a reconnection) keeps working: the stop goes.
   */
  async connectedVia(getConfig) {
    this.cancelConfigRetry();
    const attempt = ++this.configAttempt;
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (attempt !== this.configAttempt) return;
      const wait =
        TIMINGS.configRetry[Math.min(this.configFailures, TIMINGS.configRetry.length - 1)];
      this.configFailures += 1;
      this.logger.warn(
        `SMA EV Charger: reading the configuration from Gladys failed (${err?.name ?? 'Error'}); again in ${Math.round(wait / 1000)} s`,
      );
      this.configRetryWait = wait;
      this.lastStatus = undefined;
      await this.updateStatus();
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        if (attempt === this.configAttempt) {
          this.connectedVia(getConfig).catch(() =>
            this.logger.error('SMA EV Charger: start failed'),
          );
        }
      }, wait);
      return;
    }
    if (attempt !== this.configAttempt) return;
    this.configFailures = 0;
    this.configRetryWait = undefined;
    await this.connected(raw);
  }

  cancelConfigRetry() {
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (status, Discovery
   * list, badge) and the last states. Pauses, blocks, pins and guards stay;
   * a read under way is not started again, and none is started sooner than
   * the interval.
   */
  connected(raw = {}) {
    return this.serialize(async () => {
      if (!this.started || !this.config) {
        this.started = true;
        await this.doStart(raw);
        return;
      }
      if (await this.applyChange(raw)) {
        return;
      }
      this.published = undefined;
      this.badge = undefined;
      this.lastStatus = undefined;
      // The core lost its cache of states: the next read publishes them all
      // (nothing read before is sent again as new).
      this.gladys.forgetPublishedStates?.();
      await this.publishDevices();
      await this.publishBadge();
      await this.updateStatus();
    });
  }

  /**
   * New address or credentials restart (new credentials lift a block at
   * once); the interval, the option, the ceiling and the language apply at
   * once. A configuration saved unchanged reads nothing. Saves made in a row
   * apply one after the other, the last one wins.
   */
  configUpdated(raw = {}) {
    // A save wins over a getConfig() still being retried.
    this.configAttempt += 1;
    this.cancelConfigRetry();
    this.configRetryWait = undefined;
    return this.serialize(async () => {
      if (!this.config) {
        this.started = true;
        await this.doStart(raw);
        return;
      }
      const previous = this.config;
      if (await this.applyChange(raw)) {
        return;
      }
      if (this.config.allowCommands !== previous.allowCommands) {
        this.logger.info(
          `SMA EV Charger: start, mode and current ${this.config.allowCommands ? 'allowed' : 'disabled'}`,
        );
      }
      if (
        this.config.language !== previous.language ||
        this.config.maxCurrent !== previous.maxCurrent ||
        this.config.allowCommands !== previous.allowCommands
      ) {
        await this.publishAll();
      }
    });
  }

  /** A configuration received: restarts when needed (true), else applies it. */
  async applyChange(raw) {
    const next = normalizeConfig(raw);
    if (credentialsKey(next) !== credentialsKey(this.config)) {
      // First, before any wait: a late answer to the old credentials (a read, a
      // command) belongs to the old generation and never blocks the new ones.
      this.halt();
      this.token = undefined;
      this.memory.block = null;
      this.memory.lastReadAt = -Infinity;
      this.lastReadAt = -Infinity;
      await this.saveMemory();
    }
    if (this.needsRestart(next)) {
      await this.doStart(raw);
      return true;
    }
    const previous = this.config;
    this.config = next;
    if (this.config.pollInterval !== previous.pollInterval && this.readable) {
      const c = this.charger;
      if (!c.running && c.online !== false) this.schedule();
    }
    return false;
  }

  /** Only a new address or new credentials restart (an interval only reschedules). */
  needsRestart(next) {
    const c = this.config;
    return (
      JSON.stringify(next.address ?? null) !== JSON.stringify(c.address ?? null) ||
      next.invalidHost !== c.invalidHost ||
      next.credentialsInHost !== c.credentialsInHost ||
      next.badSecret !== c.badSecret ||
      credentialsKey(next) !== credentialsKey(c)
    );
  }

  async doStart(raw = {}) {
    this.halt();
    await this.charger.running?.catch(() => {});
    this.config = normalizeConfig(raw);
    await this.ensureLoaded();
    // The last start survives a restart of the configuration.
    const previous = this.charger;
    this.charger = { ...freshCharger(), lastStartAt: previous.lastStartAt };
    this.indexGuards.clear();
    this.pendingAccept = undefined;
    this.pendingTrust = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    if (!this.readable) {
      // The devices already created are shown unreachable.
      await this.publishAll();
      return;
    }
    await this.setStatus(false, this.status()[1]);
    await this.tick();
  }

  /**
   * /data read once per process (a new read could be older than the memory);
   * unreadable is NOT empty: nothing is pinned nor sent, it is read again at
   * the next tick. Then the target of the configuration: another address
   * forgets the identity, the pin and the last read of the old one.
   */
  async ensureLoaded() {
    if (!this.loaded) {
      let raw;
      try {
        raw = await this.store.load();
      } catch (err) {
        if (!this.storageBroken) {
          this.logger.warn(`SMA EV Charger: /data cannot be read (${err?.code ?? 'error'})`);
        }
        this.storageBroken = true;
        return false;
      }
      this.memory = fromDisk(raw, this.clock());
      this.loaded = true;
      this.storageBroken = false;
      this.savedKey = undefined;
      const watch = this.memory.stopWatch;
      if (watch) {
        // The watch of a stop sent by the previous life goes on.
        this.guards.set(`${watch.serial}:mode`, {
          from: undefined,
          expected: MODES.STOP,
          moved: false,
          stop: true,
          until: watch.until,
          sentAt: watch.sentAt,
          mayLand: watch.mayLand,
          confirmed: watch.confirmed,
          reasserts: watch.reasserts,
        });
      }
      // Written at most once a minute: the last read may be up to a minute
      // later than the file says (never later than now).
      if (Number.isFinite(this.memory.lastReadAt)) {
        this.lastReadAt = Math.min(this.mono(), this.memory.lastReadAt + TIMINGS.lastReadSave);
      }
    }
    const target = this.config ? (targetKey(this.config) ?? null) : null;
    if (target && this.memory.target !== target) {
      Object.assign(this.memory, {
        target,
        serial: null,
        pin: null,
        refusedPin: null,
        lastReadAt: -Infinity,
        pendingStop: null,
      });
      this.lastReadAt = -Infinity;
      this.token = undefined;
      await this.saveMemory();
    }
    return true;
  }

  /** An address, a user name and a password: the charger can be read. */
  get readable() {
    const c = this.config;
    return Boolean(c && c.address && c.auth && !c.badSecret && !c.credentialsInHost);
  }

  /** Stops the timers and gives up a session under way (a restart, a shutdown). */
  halt() {
    this.generation += 1;
    this.clearTimer();
    this.clearFollowUps();
    if (this.session) {
      this.abortSession(this.session);
    }
    this.publisher.stop();
  }

  /** The shutdown of the container: timers stopped, /data written. */
  async shutdown() {
    this.configAttempt += 1;
    this.cancelConfigRetry();
    this.halt();
    await this.saveMemory();
  }

  clearTimer() {
    if (this.charger.timer) {
      this.timers.clearTimeout(this.charger.timer);
      this.charger.timer = undefined;
    }
  }

  clearFollowUps() {
    for (const handle of this.charger.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.charger.followUps.clear();
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /**
   * Writes /data when something changed (never a secret), or when the wall
   * clock moved by a minute or more against the monotonic one (the wall
   * dates of /data follow it). Never over a file that could not be read.
   */
  async saveMemory() {
    if (!this.loaded) {
      return false;
    }
    const clock = this.clock();
    const key = JSON.stringify([this.memory, Math.round((clock.now - clock.session) / 60_000)]);
    if (key === this.savedKey) {
      return true;
    }
    try {
      await this.store.save(toDisk(this.memory, clock));
      this.savedKey = key;
      return true;
    } catch (err) {
      this.logger.warn(`Saving the state to /data failed: ${err?.code ?? 'error'}`);
      return false;
    }
  }

  // --- Credentials and certificate --------------------------------------------

  /** Credentials refused: no automatic try until other credentials or a click of the user. */
  blocked() {
    return Boolean(this.memory.block);
  }

  paused(mono = this.mono()) {
    return Boolean(this.memory.pause) && mono < this.memory.pause.until;
  }

  /**
   * Credentials refused: kept in /data, and no automatic try any more (a
   * charger may lock the account after a few refused passwords): only other
   * credentials saved, "Test the connection" (one try a minute) or a stop
   * (one login every 5 minutes) try again.
   */
  async authFailed() {
    const failures = (this.memory.block?.failures ?? 0) + 1;
    this.memory.block = { failures, refusedAt: this.mono() };
    this.token = undefined;
    await this.saveMemory();
    this.logger.warn('SMA EV Charger: credentials refused; no new try until they change');
  }

  /**
   * The certificate of a new connection, checked BEFORE anything is written:
   * the pin of the address, or, at the first connection, pinned now (kept in
   * /data before the password leaves). Another one is refused, and kept for
   * "Trust the new certificate".
   */
  async trust(fingerprint, { target, generation }) {
    const stale = () =>
      new ChargerError(ERROR_KINDS.STALE, 'The configuration changed', { notSent: true });
    // A session of another address or configuration pins nothing and sends nothing.
    if (generation !== this.generation || this.memory.target !== target || !this.loaded) {
      throw stale();
    }
    const pin = this.memory.pin;
    if (pin && pin !== fingerprint) {
      if (this.memory.refusedPin !== fingerprint) {
        this.memory.refusedPin = fingerprint;
        this.logger.warn(
          'SMA EV Charger: the certificate of the charger changed, nothing sent to it',
        );
        await this.saveMemory();
      }
      throw new ChargerError(ERROR_KINDS.CERTIFICATE, 'The certificate changed', {
        notSent: true,
        fingerprint,
      });
    }
    if (this.memory.refusedPin) {
      // The pinned certificate is back: nothing to trust any more.
      this.memory.refusedPin = null;
      this.pendingTrust = undefined;
      await this.saveMemory();
    }
    if (!pin) {
      this.memory.pin = fingerprint;
      // The first pin must be in /data before the password leaves: otherwise
      // a restart would trust whatever answers next.
      if (!(await this.saveMemory())) {
        if (this.memory.pin === fingerprint) this.memory.pin = null;
        throw new ChargerError(ERROR_KINDS.STORAGE, '/data not writable', { notSent: true });
      }
      this.logger.info('SMA EV Charger: certificate of the charger pinned (first connection)');
    }
    if (generation !== this.generation || this.memory.target !== target) {
      throw stale();
    }
  }

  /**
   * A token given by the charger, whatever the session: the credentials
   * work, so a block is lifted and the reads go on at the interval. Only for
   * the credentials of now.
   */
  async loggedIn(generation, credentials) {
    if (generation !== this.generation || credentials !== credentialsKey(this.config)) {
      return;
    }
    if (this.memory.block) {
      this.memory.block = null;
      await this.saveMemory();
      this.logger.info('SMA EV Charger: credentials accepted, block lifted');
      if (!this.charger.running && this.readable) {
        this.schedule();
      }
    }
  }

  // --- Sessions ----------------------------------------------------------------

  /** Gives a session up: its connection closed at once (a request under way fails, ABORTED). */
  abortSession(session) {
    session.aborted = true;
    session.connection?.close();
  }

  /** A session holds the charger (one given up does not: its connection is closed). */
  get busy() {
    return Boolean(this.session) && !this.session.aborted;
  }

  /**
   * Takes the charger for a new session. A stop takes it from anything, a
   * command from a poll; otherwise the session under way is waited for,
   * until `by` (monotonic; then refused: one session at a time).
   */
  async takeCharger(kind, by) {
    const current = this.session;
    if (!current) {
      return;
    }
    const preempt =
      kind === SESSION.STOP || (kind === SESSION.COMMAND && current.kind === SESSION.POLL);
    if (preempt) {
      this.abortSession(current);
    }
    const limit = preempt ? TIMINGS.preemptWait : Math.max(0, by - this.mono());
    let timer;
    await Promise.race([
      current.done,
      new Promise((resolve) => {
        timer = this.timers.setTimeout(resolve, limit);
      }),
    ]);
    this.timers.clearTimeout(timer);
    if (this.busy && !preempt) {
      throw this.refusal(ERRORS.stillRunning);
    }
  }

  /** Takes the charger, again after every wait (another session may have started meanwhile). */
  async acquire(kind, by) {
    for (let i = 0; i < 3; i += 1) {
      await this.takeCharger(kind, by);
      if (!this.busy) {
        return;
      }
    }
    throw this.refusal(ERRORS.stillRunning);
  }

  /**
   * One session on the charger, held in `this.session`. The address, the
   * credentials, the target of the pin and the generation are those of now,
   * fixed for the whole session. Never while another one holds the charger.
   * `work(api, entry)`; `deadline` (monotonic) bounds every request.
   */
  async openSession(kind, work, { deadline, generation = this.generation, stopLogin = false }) {
    if (this.busy) {
      throw this.refusal(ERRORS.stillRunning);
    }
    if (generation !== this.generation || !this.readable) {
      throw new ChargerError(ERROR_KINDS.STALE, 'The configuration changed', { notSent: true });
    }
    let release;
    const entry = {
      kind,
      connection: undefined,
      aborted: false,
      done: new Promise((resolve) => {
        release = resolve;
      }),
    };
    this.session = entry;
    const config = this.config;
    const address = config.address;
    const auth = config.auth;
    const target = targetKey(config) ?? null;
    const credentials = credentialsKey(config);
    const check = () => {
      if (entry.aborted) {
        throw new ChargerError(ERROR_KINDS.ABORTED, 'Session given up', { notSent: true });
      }
      if (generation !== this.generation) {
        throw new ChargerError(ERROR_KINDS.STALE, 'The configuration changed', { notSent: true });
      }
    };
    const ctx = (by = deadline, max = TIMINGS.readTimeout) => {
      check();
      const left = Math.min(max, by - this.mono());
      if (left <= 0) {
        throw new ChargerError(ERROR_KINDS.LATE, 'No time left', { notSent: true });
      }
      return {
        address,
        timeoutMs: left,
        trust: (fingerprint) => this.trust(fingerprint, { target, generation }),
        onOpen: (connection) => {
          entry.connection = connection;
          if (entry.aborted) connection.close();
        },
      };
    };
    const tokenNow = () => {
      const t = this.token;
      return t && t.credentials === credentials && t.target === target && this.mono() < t.until
        ? t
        : undefined;
    };
    const login = async (by) => {
      check();
      if (stopLogin && this.blocked()) {
        // A stop during a block: one login every 5 minutes after the last refusal.
        const since = this.mono() - this.memory.block.refusedAt;
        if (since < TIMINGS.blockedStopSpacing) {
          throw this.refusal(ERRORS.blockedStop(age(TIMINGS.blockedStopSpacing - since)));
        }
      }
      const answer = await this.client.login(ctx(by), auth);
      check();
      const life = Math.min(
        TIMINGS.tokenLifeMax,
        Math.max(
          TIMINGS.tokenLifeMin,
          (answer.lifeSeconds ?? TIMINGS.tokenLifeDefault / 1000) * 1000,
        ),
      );
      const token = { value: answer.token, until: this.mono() + 0.9 * life, credentials, target };
      this.token = token;
      await this.loggedIn(generation, credentials);
      return token;
    };
    /** A request with the token; an old token refused (401/403) is renewed once. */
    const call = async (fn, by = deadline) => {
      check();
      let token = tokenNow();
      let fresh = false;
      if (!token) {
        token = await login(by);
        fresh = true;
      }
      try {
        return await fn(ctx(by), token.value);
      } catch (err) {
        if (err.kind !== ERROR_KINDS.FORBIDDEN || fresh) {
          throw err;
        }
        // The token may have died on the charger (a restart): a new one, once.
        if (this.token === token) this.token = undefined;
        const renewed = await login(by);
        return await fn(ctx(by), renewed.value);
      }
    };
    const api = {
      measurements: (by) =>
        call((c, token) => this.client.measurements(c, token), by).then((m) => {
          check();
          return m;
        }),
      parameters: (by) =>
        call((c, token) => this.client.parameters(c, token), by).then((p) => {
          check();
          return p;
        }),
      write: (channelId, value, { by, beforeSend }) =>
        call(
          (c, token) =>
            this.client.write(c, token, channelId, value, {
              timestamp: timestampOf(this.now()),
              beforeSend: () => {
                if (entry.aborted) {
                  throw new ChargerError(ERROR_KINDS.ABORTED, 'Session given up');
                }
                beforeSend();
              },
            }),
          by,
        ),
    };
    try {
      check();
      return await work(api, entry);
    } finally {
      if (this.session === entry) {
        this.session = undefined;
      }
      release();
    }
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return (this.config?.pollInterval ?? 30) * SECOND;
  }

  /** No read before the last one + the interval (restarts, clicks, reconnections included). */
  get readDue() {
    return this.lastReadAt + this.interval;
  }

  /** The start of a read: kept in /data at most once a minute (an SD card is not written at every poll). */
  async markRead(mono) {
    this.lastReadAt = mono;
    if (!(mono - this.memory.lastReadAt < TIMINGS.lastReadSave)) {
      this.memory.lastReadAt = mono;
      await this.saveMemory();
    }
  }

  /**
   * The next read: after a pause or a block (never sooner than the interval),
   * after its backoff, else the interval, never before it is due.
   */
  schedule(delay) {
    const c = this.charger;
    this.clearTimer();
    const mono = this.mono();
    let wait;
    if (this.paused(mono)) {
      wait = Math.max(this.memory.pause.until - mono, this.interval);
    } else if (this.blocked()) {
      if (!this.memory.pendingStop) {
        // No automatic try with refused credentials.
        return;
      }
      wait = this.interval;
    } else {
      wait = delay ?? (c.online === false ? c.wait : this.interval);
    }
    wait = Math.max(wait ?? this.interval, this.readDue - mono);
    if (this.memory.pendingStop) {
      // A stop kept: sent again at the interval, whatever pauses the reads.
      wait = Math.min(wait, this.interval);
    }
    const generation = this.generation;
    c.timer = this.timers.setTimeout(
      () => {
        c.timer = undefined;
        if (generation === this.generation) {
          this.tick().catch(() => this.logger.error('SMA EV Charger refresh failed'));
        }
      },
      Math.max(0, wait),
    );
  }

  /** One read at a time: a tick during a read joins it. */
  tick({ followUp = false, manual = false } = {}) {
    const c = this.charger;
    if (!c.running) {
      c.running = this.run({ followUp, manual }).finally(() => {
        c.running = undefined;
      });
    }
    return c.running;
  }

  async run({ followUp = false, manual = false } = {}) {
    const generation = this.generation;
    const c = this.charger;
    if (!this.readable) {
      await this.publishAll();
      return;
    }
    if (!(await this.ensureLoaded())) {
      // /data unreadable: nothing sent (the pin is unknown); read again later.
      await this.publishAll();
      if (generation === this.generation) this.schedule(this.interval);
      return;
    }
    if (this.memory.pendingStop && !this.busy) {
      await this.sendPendingStop(generation);
      if (generation !== this.generation) return;
    }
    const mono = this.mono();
    if (this.paused(mono) || (this.blocked() && !manual)) {
      // Not read: the devices created are shown offline (never left "charging").
      await this.publishAll();
      this.schedule();
      return;
    }
    // Never sooner than the interval after the last read, whatever restarted
    // or clicked; only the two reads after a command go sooner.
    if ((!followUp && mono < this.readDue) || this.busy) {
      // A session under way (a command) holds the charger: this read waits.
      await this.publishAll();
      this.schedule(this.busy ? this.interval : this.readDue - mono);
      return;
    }
    let delay;
    await this.markRead(mono);
    if (generation !== this.generation) {
      return;
    }
    if (this.busy) {
      // A command or a stop took the charger while /data was written: this read waits.
      await this.publishAll();
      this.schedule(this.interval);
      return;
    }
    try {
      const startedAt = this.mono();
      const read = await this.openSession(SESSION.POLL, (api) => this.readAll(api), {
        deadline: startedAt + 4 * TIMINGS.readTimeout,
        generation,
      });
      if (generation !== this.generation) {
        return;
      }
      if (startedAt <= c.lastSentAt) {
        // Begun before a command left: it may show the state before it.
        this.logger.debug('SMA EV Charger: read begun before a command, not applied');
      } else {
        this.applyRead(read);
        if (this.memory.block) {
          this.memory.block = null;
        }
        await this.saveMemory();
        await this.evaluateIndex();
      }
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      if (err.kind === ERROR_KINDS.ABORTED) {
        // A command or a stop took the charger: this read is dropped, never
        // applied, and it is not a failure.
        this.logger.debug('SMA EV Charger: read given up for a command');
      } else if (err.refusal) {
        // Another session holds the charger.
        delay = this.interval;
      } else {
        delay = await this.failed(err);
      }
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule(delay);
    }
  }

  /** The measurements, then the parameters (identity, mode, current): both needed. */
  async readAll(api) {
    const measures = measuresOf(await api.measurements());
    const control = controlOf(await api.parameters());
    return { measures, control };
  }

  /** A read answered: the charger as read, and the guards it may lift. */
  applyRead({ measures, control }) {
    const c = this.charger;
    c.online = true;
    c.failures = 0;
    c.wait = undefined;
    const serial = control.serial ?? c.serial;
    if (!serial) {
      c.error = 'no_id';
      return;
    }
    c.error = undefined;
    if (c.serial && c.serial !== serial) {
      // Another charger answers at this address: the old device is no longer read.
      this.logger.warn('SMA EV Charger: another charger answers at this address');
      c.index = undefined;
    }
    c.serial = serial;
    c.readAt = this.mono();
    // The serial read last at this address, kept in /data: a stop sent
    // before the first read after a restart goes only to this device.
    this.memory.serial = serial;
    c.measures = measures;
    this.applyControl(control);
  }

  /** fromCommand: the fresh read of a command (never sends a stop again: it would race it). */
  applyControl(control, { fromCommand = false } = {}) {
    const c = this.charger;
    // Never merged with the values read before (a value missing is unknown);
    // only the model and the firmware, which name the device, are kept.
    c.control = {
      ...control,
      model: control.model ?? c.control?.model,
      firmware: control.firmware ?? c.control?.firmware,
    };
    if (c.serial) {
      this.observe(c.serial, control, { fromCommand });
    }
  }

  /** A failed read: the delay before the next one. */
  async failed(err) {
    const c = this.charger;
    const reason = errorReason(err);
    c.online = false;
    if (err.kind === ERROR_KINDS.CERTIFICATE) {
      // Nothing sent; the handshake is tried again at the interval (the pinned one may come back).
      c.error = ERROR_KINDS.CERTIFICATE;
      c.wait = this.interval;
      return c.wait;
    }
    if (err.kind === ERROR_KINDS.AUTH) {
      c.error = ERROR_KINDS.AUTH;
      await this.authFailed();
      return undefined;
    }
    if (err.kind === ERROR_KINDS.RATE_LIMITED) {
      // The charger answers: it stays online, the status shows the 429 pause.
      c.online = true;
      await this.rateLimited(err);
      this.logger.warn(`SMA EV Charger: ${reason}, pause`);
      return undefined;
    }
    // Never read again sooner than the interval.
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(c.failures, TIMINGS.backoff.length - 1)],
    );
    c.failures += 1;
    c.wait = wait;
    c.error =
      err.kind === ERROR_KINDS.FORBIDDEN
        ? ERROR_KINDS.FORBIDDEN
        : err.kind === ERROR_KINDS.STORAGE
          ? ERROR_KINDS.STORAGE
          : reason;
    c.errorReason = reason;
    if (err.kind === ERROR_KINDS.HTTP && err.status >= 500) {
      // A 5xx: a pause of the same length, kept in /data.
      const until = this.mono() + Math.max(TIMINGS.rateLimitMin, wait);
      this.memory.pause = {
        until: Math.max(this.memory.pause?.until ?? -Infinity, until),
        reason: '5xx',
      };
      await this.saveMemory();
    }
    this.logger.warn(`SMA EV Charger: ${reason}; next try in ${Math.round(wait / 1000)} s`);
    return wait;
  }

  /** A 429: every path waits but a stop (polling, button, commands), kept in /data. */
  async rateLimited(err) {
    const wait = Math.min(
      TIMINGS.rateLimitMax,
      Math.max(TIMINGS.rateLimitMin, err.retryAfter ?? TIMINGS.rateLimitDefault),
    );
    this.memory.pause = {
      until: Math.max(this.memory.pause?.until ?? -Infinity, this.mono() + wait),
      reason: '429',
    };
    await this.saveMemory();
  }

  pauseMessage(mono = this.mono()) {
    if (!this.paused(mono)) {
      return undefined;
    }
    const wait = age(this.memory.pause.until - mono);
    return this.memory.pause.reason === '5xx' ? T.serverError(wait) : T.rateLimited(wait);
  }

  /** The highest current the commands accept now (whole amperes, never below 6 A). */
  ceilingOf(control = this.charger.control) {
    const limits = [this.config?.maxCurrent ?? CURRENT.defaultCeiling];
    if (control?.limitMax !== undefined) limits.push(control.limitMax);
    if (control?.rated !== undefined && control.rated >= CURRENT.min) limits.push(control.rated);
    return Math.max(CURRENT.min, Math.floor(Math.min(...limits)));
  }

  /** The lowest current the commands accept now (whole amperes, never below 6 A). */
  floorOf(control = this.charger.control) {
    return Math.max(CURRENT.min, Math.ceil(control?.limitMin ?? CURRENT.min));
  }

  get ceiling() {
    return this.ceilingOf(this.charger.control);
  }

  summary() {
    const c = this.charger;
    const mode = c.control?.mode;
    return summaryOf(
      {
        name: deviceName(c),
        power: c.measures?.power === undefined ? undefined : Math.round(c.measures.power),
        current:
          c.control?.currentLimit === undefined
            ? undefined
            : Math.round(c.control.currentLimit * 10) / 10,
        mode: mode === undefined ? undefined : modeText(mode),
      },
      statusText(c.measures?.state, mode === undefined ? undefined : mode === MODES.STOP),
    );
  }

  /** `[connected, message, plain]`; `plain`: the summary without "Connected". */
  status() {
    const c = this.charger;
    const config = this.config;
    if (!config) {
      return [false, T.connecting];
    }
    if (config.credentialsInHost) {
      return [false, T.credentialsInHost];
    }
    if (!config.address) {
      return [false, config.invalidHost ? T.invalidHost(config.invalidHost) : T.noHost];
    }
    if (config.badSecret) {
      return [false, T.badSecret];
    }
    if (!config.auth) {
      return [false, T.noCredentials];
    }
    if (this.storageBroken) {
      return [false, T.storageUnreadable];
    }
    const mono = this.mono();
    const kept = this.memory.pendingStop ? T.pendingStop : undefined;
    const withKept = (text) => (kept ? join(text, kept) : text);
    const pause = this.pauseMessage(mono);
    if (pause) {
      return [false, withKept(pause)];
    }
    if (this.blocked()) {
      return [false, withKept(T.authRefused)];
    }
    if (c.online === false) {
      const wait = age(c.wait ?? this.interval);
      if (c.error === ERROR_KINDS.CERTIFICATE) {
        return [false, withKept(T.certificateChanged(this.memory.refusedPin))];
      }
      if (c.error === ERROR_KINDS.STORAGE) {
        return [false, withKept(T.storage)];
      }
      if (c.error === ERROR_KINDS.FORBIDDEN) {
        return [false, withKept(T.forbidden(c.errorReason ?? 'HTTP 403', wait))];
      }
      return [
        false,
        withKept(
          c.error === ERROR_KINDS.UNREACHABLE ||
            c.error === ERROR_KINDS.TIMEOUT ||
            c.error === ERROR_KINDS.LATE
            ? T.unreachable(addressKey(config.address), wait)
            : T.failing(c.error ?? 'error', wait),
        ),
      ];
    }
    if (c.online === undefined) {
      return [false, withKept(T.connecting)];
    }
    if (c.error === 'no_id' || !c.serial) {
      return [false, T.notSma];
    }
    let summary = this.summary();
    const held = this.currentHold();
    if (held) {
      summary = join(summary, T.held(held));
    }
    if (kept) {
      summary = join(summary, kept);
    }
    return [true, T.connected(summary), summary];
  }

  /** The connection status of the configuration screen. */
  async updateStatus() {
    if (this.configRetryWait !== undefined) {
      // getConfig() failing: said first (the configuration read before keeps working).
      const [, message] = this.status();
      const retry = T.configRetry(age(this.configRetryWait));
      await this.setStatus(false, this.config ? join(retry, message) : retry);
      return;
    }
    const [connected, message, plain] = this.status();
    // "Not read any more" only once a charger was read: before, the status
    // already says why nothing is read (no address, block, pause, no answer).
    const orphans = this.charger.serial !== undefined ? this.orphans() : [];
    if (orphans.length === 0) {
      await this.setStatus(connected, message);
      return;
    }
    const names = orphans
      .map((serial) => {
        const device = (this.gladys.devices ?? []).find(
          (d) => d.external_id === chargerIds(this.gladys, serial).device,
        );
        return typeof device?.name === 'string' && device.name !== ''
          ? `${device.name.slice(0, 60)} (${serial})`
          : serial;
      })
      .join(', ');
    // Not connected: the message never starts with "Connected".
    await this.setStatus(false, join(plain ?? message, T.otherCharger(names)));
  }

  // --- Energy index ----------------------------------------------------------

  indexFeatureId(serial = this.charger.serial) {
    return chargerIds(this.gladys, serial).feature(FEATURES.ENERGY_INDEX);
  }

  /**
   * The guard of an index feature of a created device, from Gladys and /data,
   * on the session clock. Gladys holds a wall date: turned into a session
   * date with the offset of now, never after the session clock now.
   */
  guardOf(featureId) {
    if (!this.indexGuards.has(featureId)) {
      const session = this.sessionNow();
      const offset = this.now() - session;
      const known = lastValueOf(this.gladys.devices, featureId);
      this.indexGuards.set(
        featureId,
        new IndexGuard(
          known ? { value: known.value, at: Math.min(known.at - offset, session) } : undefined,
          this.memory.indexes[featureId],
          session,
          GUARD_LIMITS,
        ),
      );
    }
    return this.indexGuards.get(featureId);
  }

  /** The value held back on the index of the charger read, else undefined. */
  currentHold() {
    const c = this.known();
    return c ? this.indexGuards.get(this.indexFeatureId(c.serial))?.held : undefined;
  }

  /**
   * The meter reading through the guard, once per read: what may be
   * published (`c.index`), the guard written to /data BEFORE Gladys gets the
   * value (a crash in between never sends an index /data does not know).
   * Only once the device is created (its feature exists).
   */
  async evaluateIndex() {
    const c = this.known();
    if (!c) {
      return;
    }
    const featureId = this.indexFeatureId(c.serial);
    if (!this.createdFeatures().has(featureId)) {
      c.index = undefined;
      return;
    }
    const guard = this.guardOf(featureId);
    const total =
      c.measures?.totalEnergy === undefined ? undefined : round3(c.measures.totalEnergy);
    if (total === undefined) {
      // Not in this answer: the last accepted value keeps its date in Gladys.
      c.index = guard.held ? guard.last?.value : undefined;
    } else {
      const plausible = guard.accept(total, this.sessionNow());
      c.index = plausible ? total : guard.held ? guard.last?.value : undefined;
    }
    const held = guard.held;
    const key = held ? `${featureId}:${holdKey(held)}` : undefined;
    if (key && key !== this.loggedHold) {
      this.logger.warn(
        `SMA EV Charger energy index ${held.direction === 'down' ? 'drop' : 'jump'} held back: the "Accept the held index" button takes it`,
      );
    }
    this.loggedHold = key;
    const kept = Object.entries(this.memory.indexes).filter(([id]) => id !== featureId);
    this.memory.indexes = Object.fromEntries(
      [[featureId, guard.state()], ...kept].slice(0, LIMITS.indexStates),
    );
    await this.saveMemory();
  }

  // --- Gladys ----------------------------------------------------------------

  /** The charger read with a valid identity, else undefined. */
  known() {
    const c = this.charger;
    return c.serial && c.measures && c.control ? c : undefined;
  }

  /**
   * The serials of the devices created in Gladys that the charger read is
   * not (another charger at this address, an address changed, or no answer
   * since the start): shown offline. Empty while a first read is still under
   * way.
   */
  orphans() {
    const c = this.charger;
    const mono = this.mono();
    if (c.online === undefined && !this.blocked() && !this.paused(mono) && this.readable) {
      return [];
    }
    const serials = [];
    for (const device of this.gladys.devices ?? []) {
      const serial = parseDeviceId(device?.external_id);
      if (
        serial &&
        serial !== c.serial &&
        chargerIds(this.gladys, serial).device === device.external_id
      ) {
        serials.push(serial);
      }
    }
    return serials;
  }

  /**
   * Whether the values of the last read are recent enough to be published
   * (a reconnection, a device created, a restart never republish old values
   * as new ones): within two intervals and the time of a read.
   */
  fresh(c, mono = this.mono()) {
    return c.readAt !== undefined && mono - c.readAt <= 2 * this.interval + 4 * TIMINGS.readTimeout;
  }

  async publishAll() {
    await this.publishDevices();
    this.queueStates();
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  async publishDevices() {
    const c = this.known();
    if (!c) {
      return;
    }
    const devices = [
      buildDevice(this.gladys, c, { ceiling: this.ceiling, language: this.config.language }),
    ];
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  queueStates(created = this.createdFeatures()) {
    const language = this.config?.language ?? 'fr';
    const push = (serial, charger, online) => {
      const states = deviceStates(chargerIds(this.gladys, serial), charger, {
        online,
        language,
        ceiling: this.ceiling,
        index: charger.index,
      });
      for (const { device_feature_external_id: id, ...value } of states) {
        if (created.has(id)) {
          this.publisher.push(id, value);
        }
      }
    };
    const c = this.known();
    if (c && (c.online === false || this.fresh(c))) {
      push(c.serial, c, c.online !== false);
    }
    // A created device the charger read is not: unreachable, never left "charging".
    for (const serial of this.orphans()) {
      push(serial, {}, false);
    }
  }

  async publishBadge() {
    const created = new Set((this.gladys.devices ?? []).map((d) => d.external_id));
    const entries = [];
    const c = this.known();
    if (c && created.has(chargerIds(this.gladys, c.serial).device)) {
      const held = this.currentHold();
      entries.push({
        external_id: chargerIds(this.gladys, c.serial).device,
        transport: c.online === false ? DEVICE_TRANSPORTS.UNREACHABLE : DEVICE_TRANSPORTS.LOCAL,
        ...(held ? { degraded: true, message: T.badge.held(held) } : {}),
      });
    }
    for (const serial of this.orphans()) {
      entries.push({
        external_id: chargerIds(this.gladys, serial).device,
        transport: DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): its index guard, then its last values at once (no read). */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    await this.evaluateIndex();
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  /** A device deleted: its pending states and its index guard go (added again, a fresh guard). */
  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id !== 'string') {
      return;
    }
    this.publisher.forget(device.external_id);
    const prefix = `${device.external_id}:`;
    for (const id of [...this.indexGuards.keys()]) {
      if (id.startsWith(prefix)) {
        this.indexGuards.delete(id);
      }
    }
    this.memory.indexes = Object.fromEntries(
      Object.entries(this.memory.indexes).filter(([id]) => !id.startsWith(prefix)),
    );
    if (parseDeviceId(device.external_id) === this.charger.serial) {
      this.charger.index = undefined;
      this.pendingAccept = undefined;
    }
    await this.saveMemory();
  }

  /** The Discovery tab asks for a scan: the device of the last read, sent again (no read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration buttons -------------------------------------------------------

  lastMessage() {
    return JSON.parse(this.lastStatus ?? '[false,null]')[1];
  }

  /** Reads the charger now, if a read is due (never sooner than the interval). */
  async testConnection() {
    const mono = this.mono();
    if (!this.readable || this.paused(mono) || this.storageBroken) {
      return this.status()[1];
    }
    if (this.blocked()) {
      // Refused credentials: the button tries once more, at most once a minute.
      const since = mono - this.memory.block.refusedAt;
      if (since < TIMINGS.blockedTestSpacing || this.session) {
        return join(T.test.blockedWait(age(TIMINGS.blockedTestSpacing - since)), this.status()[1]);
      }
      if (mono < this.readDue) {
        return join(T.test.notDue(age(Math.max(SECOND, this.readDue - mono))), this.status()[1]);
      }
      await this.charger.running?.catch(() => {});
      await this.tick({ manual: true });
      return this.lastMessage() ?? T.connecting;
    }
    if (mono < this.readDue || this.session) {
      const last = this.lastMessage();
      const notDue = T.test.notDue(age(Math.max(SECOND, this.readDue - mono)));
      return last ? join(notDue, last) : notDue;
    }
    // A read now (a read in progress is joined).
    await this.tick();
    return this.lastMessage() ?? T.connecting;
  }

  /** Whether `pending` is a valid first click for a second one now (3 s to 60 s ago). */
  secondClick(pending, mono) {
    return (
      pending !== undefined &&
      mono - pending.at >= TIMINGS.confirmAfter &&
      mono - pending.at <= TIMINGS.confirmWithin
    );
  }

  /**
   * "Trust the new certificate", in two clicks: the first one shows the whole
   * fingerprint refused and pins nothing; a second one 3 to 60 s later pins
   * exactly that fingerprint, if it is still the one refused, then reads at
   * once (a choice of the user, like new credentials). Never a certificate
   * that was not shown.
   */
  async trustCertificate() {
    const refused = this.memory.refusedPin;
    if (!refused || !this.readable || !this.loaded) {
      this.pendingTrust = undefined;
      return T.trust.nothing;
    }
    const pending = this.pendingTrust;
    const mono = this.mono();
    if (!this.secondClick(pending, mono) || pending.fingerprint !== refused) {
      this.pendingTrust = { fingerprint: refused, at: mono };
      return T.trust.confirm(refused);
    }
    this.pendingTrust = undefined;
    this.memory.pin = refused;
    this.memory.refusedPin = null;
    this.memory.lastReadAt = -Infinity;
    this.lastReadAt = -Infinity;
    this.charger.error = undefined;
    await this.saveMemory();
    this.logger.info('SMA EV Charger: the new certificate of the charger was trusted by the user');
    await this.charger.running?.catch(() => {});
    await this.tick();
    const last = this.lastMessage();
    return last ? join(T.trust.done(refused), last) : T.trust.done(refused);
  }

  /**
   * "Accept the held index", in two clicks. The first one takes nothing: it
   * lists the value held (drop or jump, from → to, kWh). A second click 3 to
   * 60 s later takes exactly that, if the hold is still the same (direction,
   * from, threshold) and its value is still the one listed plus what the
   * charger may have delivered since (a jump not below it, a drop not above
   * it plus that margin); otherwise it is a first click again. A save of the
   * configuration or a reconnection never accepts anything.
   */
  async acceptHeldIndex() {
    const c = this.known();
    const featureId = c ? this.indexFeatureId(c.serial) : undefined;
    const guard = featureId ? this.indexGuards.get(featureId) : undefined;
    const held = guard?.held;
    if (!held) {
      this.pendingAccept = undefined;
      return T.accept.nothing;
    }
    const mono = this.mono();
    const session = this.sessionNow();
    const fingerprint = `${featureId}:${holdKey(held)}`;
    const pending = this.pendingAccept;
    const asListed = () => {
      const top = pending.listed.to + guard.margin(pending.listed.at, session);
      return held.direction === 'up'
        ? held.to >= pending.listed.to && held.to <= top
        : held.to <= top;
    };
    if (
      !this.secondClick(pending, mono) ||
      pending.fingerprint !== fingerprint ||
      pending.guard !== guard ||
      !asListed()
    ) {
      this.pendingAccept = { fingerprint, guard, at: mono, listed: { to: held.to, at: session } };
      return T.accept.confirm(held);
    }
    this.pendingAccept = undefined;
    const taken = guard.acceptHeld();
    this.logger.info(
      `SMA EV Charger energy index ${taken.direction === 'down' ? 'drop' : 'jump'} from ${taken.from} to ${taken.to} kWh accepted by the user`,
    );
    // The value held is the one of the last read: taken now.
    await this.evaluateIndex();
    this.badge = undefined;
    await this.publishAll();
    return T.accept.done(taken);
  }

  // --- Commands --------------------------------------------------------------------

  refusal(text) {
    return Object.assign(new Error(word(text, this.config?.language)), { refusal: true });
  }

  /**
   * The value of a command, strictly: null, '', ' ', true or 1.5 are never
   * read as a number. Throws a refusal when it is not valid.
   */
  commandValue(role, value) {
    if (role === FEATURES.STOP || role === FEATURES.START) {
      if (value === PRESSED || value === String(PRESSED)) {
        return PRESSED;
      }
      throw this.refusal(ERRORS.badButton);
    }
    if (role === FEATURES.SET_MODE) {
      if (typeof value === 'string' && Object.hasOwn(MODE_OPTIONS, value)) {
        return value;
      }
      throw this.refusal(ERRORS.badMode);
    }
    const amps =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\d{1,3}$/.test(value)
          ? Number(value)
          : NaN;
    if (!Number.isInteger(amps)) {
      throw this.refusal(ERRORS.badCurrent);
    }
    if (amps < CURRENT.min || amps > CURRENT.max) {
      throw this.refusal(ERRORS.outOfBounds(CURRENT.min, CURRENT.max));
    }
    return amps;
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.mono();
    const target = parseFeatureId(feature?.external_id);
    if (!target || !COMMAND_ROLES.includes(target.role)) {
      throw this.refusal(ERRORS.readOnly);
    }
    const { role } = target;
    const wanted = this.commandValue(role, value);
    const isStop = isStopCommand(role, wanted);
    if (!this.config) {
      throw this.refusal(ERRORS.noConfig);
    }
    if (!isStop && !this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (role === FEATURES.SET_CURRENT && wanted > this.ceiling) {
      // Above the ceiling known now: refused without a session (checked again on the fresh read).
      throw this.refusal(ERRORS.outOfBounds(this.floorOf(), this.ceiling));
    }
    if (!this.readable) {
      throw this.refusal(ERRORS.noAddress);
    }
    if (!(await this.ensureLoaded())) {
      throw this.refusal(ERRORS.storageUnreadable);
    }
    if (!this.isTarget(target.serial, isStop)) {
      throw this.refusal(
        !isStop && this.charger.serial === undefined ? ERRORS.notReadYet : ERRORS.unknownCharger,
      );
    }
    const previous = this.inFlight;
    if (previous && isStop && previous.isStop && !previous.settled) {
      // A stop still under way: this one shares its outcome.
      return previous.promise;
    }
    // One command at a time: a busy charger refuses at once, but a stop is
    // never held back: it takes the charger from the command under way.
    if (previous && !isStop) {
      throw this.refusal(ERRORS.stillRunning);
    }
    const entry = {
      role,
      wanted,
      isStop,
      startLike: !isStop && (role === FEATURES.START || role === FEATURES.SET_MODE),
      sentAt: undefined,
      overtaken: previous,
      promise: undefined,
      settled: false,
    };
    this.inFlight = entry;
    entry.promise = this.command(target.serial, entry, received);
    try {
      return await entry.promise;
    } finally {
      entry.settled = true;
      if (this.inFlight === entry) {
        this.inFlight = undefined;
      }
    }
  }

  /**
   * Whether a command of the device `serial` goes to the charger at the
   * address. A stop also goes when no read gave a serial yet (a pause or a
   * block kept in /data across a restart, a first read under way) for the
   * device of the last serial read at this address (kept in /data): stopping
   * is never held back. Never when another charger was read at the address.
   * Without a serial in /data, any device created in Gladys.
   */
  isTarget(serial, isStop) {
    if (this.charger.serial !== undefined) {
      return this.charger.serial === serial;
    }
    if (!isStop) {
      return false;
    }
    if (this.memory.serial) {
      return this.memory.serial === serial;
    }
    return (this.gladys.devices ?? []).some(
      (d) => d.external_id === chargerIds(this.gladys, serial).device,
    );
  }

  /** The checks before sending, on the latest configuration (a stop: only the target). */
  checkBeforeSend(generation, serial, isStop) {
    if (generation !== this.generation || !this.isTarget(serial, isStop)) {
      throw this.refusal(ERRORS.unknownCharger);
    }
    if (!this.readable) {
      throw this.refusal(ERRORS.noAddress);
    }
    if (isStop) {
      return;
    }
    const mono = this.mono();
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (this.paused(mono)) {
      const wait = age(this.memory.pause.until - mono);
      throw this.refusal(
        this.memory.pause.reason === '5xx' ? ERRORS.serverPaused(wait) : ERRORS.paused(wait),
      );
    }
    if (this.blocked()) {
      throw this.refusal(ERRORS.blocked);
    }
    const since = mono - this.memory.lastChangeAt;
    if (since < TIMINGS.changeMinInterval) {
      throw this.refusal(ERRORS.tooOften(age(TIMINGS.changeMinInterval - since)));
    }
  }

  /** A stop arrived after `entry` started: anything but a stop gives way. */
  stopArrived(entry) {
    return !entry.isStop && this.inFlight !== entry;
  }

  /**
   * What to write (`{ channel, value, guardKey, expected, from }`), from the
   * state just read; undefined when already so (unless a guard holds).
   */
  plan(entry, fresh, serial) {
    const { role, wanted } = entry;
    if (entry.isStop) {
      return {
        channel: PARAMS.MODE,
        value: MODES.STOP,
        guardKey: 'mode',
        expected: MODES.STOP,
        from: this.charger.control?.mode,
      };
    }
    const control = fresh.control;
    if (control.serial && serial && control.serial !== serial) {
      throw new ChargerError(ERROR_KINDS.OTHER_CHARGER, 'Another charger', { notSent: true });
    }
    if (role === FEATURES.SET_CURRENT) {
      if (control.currentLimit === undefined) {
        throw this.refusal(ERRORS.missing);
      }
      const ceiling = this.ceilingOf(control);
      const floor = this.floorOf(control);
      if (wanted > ceiling || wanted < floor) {
        throw this.refusal(ERRORS.outOfBounds(floor, ceiling));
      }
      if (
        Math.abs(control.currentLimit - wanted) <= CURRENT.tolerance &&
        !this.guardActive(serial, 'current')
      ) {
        return undefined;
      }
      return {
        channel: PARAMS.CURRENT_LIMIT,
        value: String(wanted),
        guardKey: 'current',
        expected: wanted,
        from: control.currentLimit,
      };
    }
    // A start (boost) or another mode.
    const code = role === FEATURES.START ? MODES.BOOST : MODE_OPTIONS[wanted];
    const state = fresh.measures.state;
    if (role === FEATURES.START && state === STATE.STANDBY) {
      throw this.refusal(ERRORS.noVehicle);
    }
    if (
      state === STATE.ERROR ||
      state === STATE.LOCKED ||
      state === STATE.UNKNOWN ||
      (role === FEATURES.START && !PLUGGED_STATES.has(state))
    ) {
      throw this.refusal(ERRORS.fault(STATE_NAMES[state] ?? STATE_NAMES[STATE.UNKNOWN]));
    }
    if (control.mode === undefined) {
      throw this.refusal(ERRORS.missing);
    }
    if (control.possibleModes && !control.possibleModes.includes(code)) {
      throw this.refusal(ERRORS.modeNotOffered(MODE_NAMES[code]));
    }
    if (control.mode === code && !this.guardActive(serial, 'mode')) {
      return undefined;
    }
    return {
      channel: PARAMS.MODE,
      value: code,
      guardKey: 'mode',
      expected: code,
      from: control.mode,
    };
  }

  /** A start not confirmed may still land on the charger. */
  unconfirmedStart(mono = this.mono()) {
    return mono < this.memory.unconfirmedStartUntil;
  }

  /** A start of Gladys may still land: in flight, overtaken, unconfirmed, or under its guard. */
  startMayLand(entry, serial) {
    const guard = this.guards.get(`${serial}:mode`);
    return (
      entry.overtaken?.startLike === true ||
      this.inFlight?.startLike === true ||
      this.unconfirmedStart() ||
      (this.guardActive(serial, 'mode') && guard?.expected !== MODES.STOP)
    );
  }

  async command(serial, entry, received) {
    const generation = this.generation;
    const { isStop } = entry;
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    let plan;
    try {
      this.checkBeforeSend(generation, serial, isStop);
      await this.acquire(isStop ? SESSION.STOP : SESSION.COMMAND, sendBy - TIMINGS.commandMinSend);
      if (this.stopArrived(entry)) {
        throw this.refusal(ERRORS.stopMeanwhile);
      }
      this.checkBeforeSend(generation, serial, isStop);
      if (isStop) {
        // A stop may land while a start of Gladys is still out: decided now.
        entry.mayLand = this.startMayLand(entry, serial);
        plan = this.plan(entry, undefined, serial);
        await this.sendStop(entry, plan, { serial, generation, sendBy, answerBy });
      } else {
        await this.openSession(
          SESSION.COMMAND,
          async (api, session) => {
            const readStart = this.mono();
            const by = sendBy - TIMINGS.commandMinSend;
            // The state just before acting, read in this session, never the one in memory.
            const measures =
              entry.role === FEATURES.SET_CURRENT
                ? undefined
                : measuresOf(await api.measurements(by));
            const control = controlOf(await api.parameters(by));
            const fresh = { measures, control };
            this.applyFresh(fresh, readStart);
            plan = this.plan(entry, fresh, serial);
            if (!plan) {
              return;
            }
            // The minute between two changes is kept in /data BEFORE the first
            // byte: a restart right after never sends another change sooner.
            const previousChange = this.memory.lastChangeAt;
            this.memory.lastChangeAt = this.mono();
            entry.previousChangeAt = previousChange;
            entry.changeAt = this.memory.lastChangeAt;
            if (!(await this.saveMemory())) {
              this.memory.lastChangeAt = previousChange;
              throw this.refusal(ERRORS.storage);
            }
            await api.write(plan.channel, plan.value, {
              by: answerBy,
              // The last checks, right before the bytes go.
              beforeSend: () => {
                if (generation !== this.generation || session.aborted) {
                  throw this.refusal(ERRORS.configChanged);
                }
                if (this.stopArrived(entry)) {
                  throw this.refusal(ERRORS.stopMeanwhile);
                }
                this.checkCommand(generation, serial);
                if (this.mono() > sendBy) {
                  throw this.refusal(ERRORS.tooSlow);
                }
                if (
                  plan.channel === PARAMS.CURRENT_LIMIT &&
                  Number(plan.value) > this.ceilingOf(control)
                ) {
                  // The ceiling lowered meanwhile.
                  throw this.refusal(
                    ERRORS.outOfBounds(this.floorOf(control), this.ceilingOf(control)),
                  );
                }
                this.markSent(entry);
                this.logger.info(`SMA EV Charger: ${entry.role} (${plan.channel}=${plan.value})`);
              },
            });
            entry.outcome = await this.confirmRead(api, plan, answerBy);
          },
          { deadline: sendBy - TIMINGS.commandMinSend, generation },
        );
      }
    } catch (err) {
      throw await this.commandFailed(err, { serial, entry, plan, generation });
    }
    if (!plan || generation !== this.generation) {
      // Nothing written (already so), or an answer of a configuration replaced since.
      if (entry.changeAt !== undefined && entry.sentAt === undefined) this.unspend(entry);
      return;
    }
    // Accepted by the charger: confirmed only by a read showing the value
    // asked. Otherwise the guard holds until a read shows it (5 s and 20 s
    // after); a stop is watched by the reads whatever the read said.
    if (entry.outcome !== 'applied' || entry.isStop) {
      this.guard(serial, plan, entry);
    }
    this.followUp();
    if (entry.outcome === 'before') {
      throw this.refusal(ERRORS.notYetApplied);
    }
    if (entry.outcome !== 'applied') {
      throw this.refusal(ERRORS.sentUnconfirmed(entry.outcome ?? 'no read in time'));
    }
  }

  /**
   * The read right after a write accepted, in the same session, when the
   * time left allows it: 'applied' when it shows the value asked, 'before'
   * when it still shows the value before, else the reason it says nothing.
   * Never thrown: the command left, its answer is "sent" whatever happens.
   */
  async confirmRead(api, plan, answerBy) {
    if (answerBy - this.mono() < TIMINGS.confirmReadMin) {
      return undefined;
    }
    const readStart = this.mono();
    try {
      const control = controlOf(await api.parameters(answerBy));
      this.applyFresh({ control }, readStart);
      const value = plan.channel === PARAMS.MODE ? control.mode : control.currentLimit;
      const same = (a, b) =>
        typeof a === 'number' ? Math.abs(a - Number(b)) <= CURRENT.tolerance : a === b;
      if (value === undefined) return 'value not read';
      if (same(value, plan.expected)) return 'applied';
      // A stop not read stopped is not applied yet, whatever was read before it.
      return plan.expected === MODES.STOP || (plan.from !== undefined && same(value, plan.from))
        ? 'before'
        : 'another value read';
    } catch (err) {
      return errorReason(err);
    }
  }

  /** The checks of a non-protective command right before its bytes go (the minute aside: it is ours). */
  checkCommand(generation, serial) {
    if (generation !== this.generation || !this.isTarget(serial, false)) {
      throw this.refusal(ERRORS.unknownCharger);
    }
    if (!this.readable) {
      throw this.refusal(ERRORS.noAddress);
    }
    const mono = this.mono();
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (this.paused(mono)) {
      throw this.refusal(ERRORS.paused(age(this.memory.pause.until - mono)));
    }
    if (this.blocked()) {
      throw this.refusal(ERRORS.blocked);
    }
  }

  /**
   * The stop: one write, no read, in its own session; not sent because the
   * charger could not be reached, it is tried again within its budget
   * (TIMINGS.stopRetryGap apart).
   */
  async sendStop(entry, plan, { serial, generation, sendBy, answerBy }) {
    for (;;) {
      try {
        await this.openSession(
          SESSION.STOP,
          (api, session) =>
            api
              .write(plan.channel, plan.value, {
                by: answerBy,
                beforeSend: () => {
                  if (generation !== this.generation || session.aborted) {
                    throw this.refusal(ERRORS.configChanged);
                  }
                  if (!this.isTarget(serial, true)) {
                    throw this.refusal(ERRORS.unknownCharger);
                  }
                  this.markSent(entry);
                  this.logger.info('SMA EV Charger: stop (mode "Charge stop")');
                },
              })
              .then(async () => {
                entry.outcome = await this.confirmRead(api, plan, answerBy);
              }),
          { deadline: sendBy, generation, stopLogin: true },
        );
        return;
      } catch (err) {
        const retry =
          err?.kind === ERROR_KINDS.UNREACHABLE &&
          entry.sentAt === undefined &&
          this.mono() + TIMINGS.stopRetryGap + TIMINGS.commandMinSend < sendBy &&
          generation === this.generation;
        if (!retry) throw err;
        await sleep(this.timers, TIMINGS.stopRetryGap);
        if (this.busy) await this.acquire(SESSION.STOP, sendBy);
      }
    }
  }

  /** A read of a command (before or after its write), applied only when no command left during it. */
  applyFresh(fresh, readStart) {
    const c = this.charger;
    if (readStart <= c.lastSentAt) {
      return;
    }
    if (fresh.measures) {
      c.measures = fresh.measures;
      c.readAt = this.mono();
    }
    this.applyControl(fresh.control, { fromCommand: true });
    // Shown in the background: the ack never waits for Gladys.
    this.publishAll().catch((err) => this.logger.warn(`Publishing failed: ${err.message}`));
  }

  /** The bookkeeping of a write at the moment it leaves (synchronous: nothing awaited). */
  markSent(entry) {
    const c = this.charger;
    const mono = this.mono();
    entry.sentAt = mono;
    c.lastSentAt = mono;
    if (entry.startLike) {
      c.lastStartAt = mono;
    }
    if (entry.isStop || entry.startLike) {
      // A stop that leaves replaces one kept; a start that leaves cancels it.
      this.memory.pendingStop = null;
    }
    if (entry.startLike && this.memory.stopWatch) {
      // A start that leaves ends the watch of the stop before it.
      this.guards.delete(`${this.memory.stopWatch.serial}:mode`);
      this.memory.stopWatch = null;
    }
    this.saveMemory().catch(() => {});
  }

  /** A write the charger refused (or never sent): the minute between two changes is not spent. */
  unspend(entry) {
    if (entry.changeAt !== undefined && this.memory.lastChangeAt === entry.changeAt) {
      this.memory.lastChangeAt = entry.previousChangeAt ?? -Infinity;
      entry.changeAt = undefined;
      this.saveMemory().catch(() => {});
    }
  }

  /** Keeps a stop not sent in /data: sent again before the next reads (3 times within 15 min). */
  async keepStop(serial) {
    this.memory.pendingStop = { serial, at: this.mono(), tries: 0 };
    await this.saveMemory();
    this.logger.warn('SMA EV Charger: stop not sent, kept to be sent again');
    if (!this.charger.running) this.schedule();
    await this.updateStatus();
  }

  /**
   * The stop kept in /data, sent again before a read: dropped when too old,
   * tried too often, cancelled by a start that left since, or meant for
   * another charger. Its own session (no read), no option.
   */
  async sendPendingStop(generation) {
    const kept = this.memory.pendingStop;
    const mono = this.mono();
    if (
      mono - kept.at >= TIMINGS.pendingStopMax ||
      kept.tries >= TIMINGS.pendingStopTries ||
      this.charger.lastStartAt > kept.at ||
      !this.isTarget(kept.serial, true)
    ) {
      this.memory.pendingStop = null;
      await this.saveMemory();
      return;
    }
    if (this.blocked() && mono - this.memory.block.refusedAt < TIMINGS.blockedStopSpacing) {
      // A refused password is never sent again in a loop: the next tick tries.
      return;
    }
    kept.tries += 1;
    await this.saveMemory();
    const entry = { role: FEATURES.STOP, isStop: true, startLike: false, overtaken: undefined };
    const plan = this.plan(entry, undefined, kept.serial);
    entry.mayLand = this.startMayLand(entry, kept.serial);
    try {
      await this.openSession(
        SESSION.STOP,
        (api) =>
          api.write(plan.channel, plan.value, {
            by: this.mono() + 2 * TIMINGS.readTimeout,
            beforeSend: () => {
              if (generation !== this.generation || !this.isTarget(kept.serial, true)) {
                throw this.refusal(ERRORS.unknownCharger);
              }
              if (this.memory.pendingStop !== kept) {
                // Replaced by a stop or cancelled by a start meanwhile.
                throw this.refusal(ERRORS.stopMeanwhile);
              }
              this.markSent(entry);
              this.logger.info('SMA EV Charger: stop kept, sent again');
            },
          }),
        { deadline: this.mono() + 3 * TIMINGS.readTimeout, generation, stopLogin: true },
      );
      this.guard(kept.serial, plan, entry);
      this.followUp();
    } catch (err) {
      if (generation !== this.generation) return;
      if (entry.sentAt !== undefined && !notSent(err)) {
        // It may have reached the charger: watched by the reads like any stop.
        this.guard(kept.serial, plan, entry);
        this.followUp();
      }
      if (err.kind === ERROR_KINDS.RATE_LIMITED) await this.rateLimited(err);
      if (err.kind === ERROR_KINDS.AUTH) await this.authFailed();
      this.logger.warn(`SMA EV Charger: stop kept, not sent again (${errorReason(err)})`);
      await this.saveMemory();
    }
  }

  /**
   * The error a failed command answers, and what it leaves behind (guards,
   * pauses, block, a stop kept). A command of a configuration replaced
   * meanwhile leaves nothing behind: its answer only goes back to Gladys.
   */
  async commandFailed(err, { serial, entry, plan, generation }) {
    const stale = generation !== this.generation;
    const sent = entry.sentAt !== undefined;
    if (err?.refusal) {
      if (!sent) this.unspend(entry);
      return err;
    }
    const reason = errorReason(err);
    const { isStop } = entry;
    if (sent && (err.kind === ERROR_KINDS.REJECTED || err.kind === ERROR_KINDS.FORBIDDEN)) {
      // The charger answered the write itself with a refusal: not applied.
      this.unspend(entry);
      if (!stale) this.followUp();
      return this.refusal(
        err.kind === ERROR_KINDS.FORBIDDEN ? ERRORS.forbidden(reason) : ERRORS.refused(reason),
      );
    }
    if (!sent || notSent(err)) {
      // Nothing written (the minute between two changes is not spent).
      this.unspend(entry);
      const keep = async () => {
        if (isStop && !stale) {
          await this.keepStop(serial);
          return this.refusal(ERRORS.stopKept(reason));
        }
        return undefined;
      };
      switch (err.kind) {
        case ERROR_KINDS.CERTIFICATE:
          return this.refusal(ERRORS.certificate);
        case ERROR_KINDS.OTHER_CHARGER:
          return this.refusal(ERRORS.otherCharger);
        case ERROR_KINDS.STALE:
          return this.refusal(ERRORS.configChanged);
        case ERROR_KINDS.STORAGE:
          return this.refusal(ERRORS.storage);
        case ERROR_KINDS.LATE:
          // Before the write, every request is bounded by the deadline of the command.
          return (await keep()) ?? this.refusal(ERRORS.tooSlow);
        case ERROR_KINDS.TIMEOUT:
          // A read or the token request was silent: nothing was written.
          return (await keep()) ?? this.refusal(ERRORS.tooSlow);
        case ERROR_KINDS.ABORTED:
          return this.refusal(stale ? ERRORS.configChanged : ERRORS.stopMeanwhile);
        case ERROR_KINDS.FORBIDDEN:
          // A read refused with a token just given: no right to it.
          return this.refusal(ERRORS.forbidden(reason));
        case ERROR_KINDS.AUTH:
          if (!stale && this.config.auth) {
            if (isStop && this.memory.block) {
              // A stop during a block: its own spacing only, the reads keep theirs.
              this.memory.block.refusedAt = this.mono();
              await this.saveMemory();
            } else {
              await this.authFailed();
            }
            this.updateStatus().catch(() => {});
          }
          return this.refusal(ERRORS.credentialsRefused);
        case ERROR_KINDS.RATE_LIMITED:
          if (!stale) {
            await this.rateLimited(err);
            this.updateStatus().catch(() => {});
          }
          return (
            (await keep()) ??
            this.refusal(
              ERRORS.rateLimitedNotSent(
                age(Math.max(0, (this.memory.pause?.until ?? 0) - this.mono())),
              ),
            )
          );
        default:
          if (!isStop && plan === undefined) {
            return this.refusal(ERRORS.unknownState(reason));
          }
          return (await keep()) ?? this.refusal(ERRORS.notSent(reason));
      }
    }
    this.logger.warn(`SMA EV Charger: ${entry.role} failed (${reason})`);
    if (err.kind === ERROR_KINDS.RATE_LIMITED) {
      if (!stale) {
        await this.rateLimited(err);
        this.updateStatus().catch(() => {});
      }
      this.unspend(entry);
      return this.refusal(ERRORS.refused(reason));
    }
    // A silence, a 5xx, a cut connection after the write: it may have reached the charger.
    if (!stale) {
      if (entry.startLike) {
        // It may still land later, even after a stop: a stop sent within the
        // next 90 s is sent again if a read shows the charger not stopped.
        this.memory.unconfirmedStartUntil = this.mono() + TIMINGS.guard;
        await this.saveMemory();
      }
      this.guard(serial, plan, entry);
      this.followUp();
    }
    return this.refusal(ERRORS.sentUnconfirmed(reason));
  }

  /** Spaced reads after a command: its effect, then a check (each a new read; one series at a time). */
  followUp() {
    const generation = this.generation;
    const c = this.charger;
    this.clearFollowUps();
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        c.followUps.delete(handle);
        if (generation !== this.generation) {
          return;
        }
        // A read or a session under way began before: wait for it, then read again.
        Promise.resolve(c.running)
          .catch(() => {})
          .then(() => this.session?.done)
          .then(() => this.tick({ followUp: true }))
          .catch(() => this.logger.error('SMA EV Charger refresh failed'));
      }, delay);
      c.followUps.add(handle);
    }
  }

  // --- Guards ----------------------------------------------------------------------

  /**
   * After a command, until the charger shows it: a new command is always
   * sent, never answered "already so" on a state that may not show the
   * previous one yet. The start state is kept: a read equal to it lifts
   * nothing until a move was seen. A stop's guard holds its whole 90 s and
   * watches the reads (see observe).
   */
  guard(serial, plan, entry) {
    const key = `${serial}:${plan.guardKey}`;
    const held = this.guards.get(key);
    const isStop = plan.expected === MODES.STOP;
    // A stop sent again keeps the watch of the stop it repeats.
    const keep = isStop && held?.stop && this.guardActive(serial, plan.guardKey);
    const guard = {
      from: plan.from,
      expected: plan.expected,
      moved: false,
      until: keep ? held.until : this.mono() + TIMINGS.guard,
      stop: isStop,
      /** When the stop left: a start that left after it ends the watch. */
      sentAt: entry?.sentAt ?? this.mono(),
      /** A start of Gladys may land after the stop: sent again even once seen stopped. */
      mayLand: Boolean(entry?.mayLand) || Boolean(keep && held.mayLand),
      confirmed: false,
      reasserts: keep ? held.reasserts : 0,
    };
    this.guards.set(key, guard);
    if (isStop) {
      this.keepWatch(serial, guard);
    } else if (plan.guardKey === 'mode' && this.memory.stopWatch) {
      this.memory.stopWatch = null;
      this.saveMemory().catch(() => {});
    }
  }

  /** The watch of a stop, kept in /data: a restart within its 90 s goes on watching. */
  keepWatch(serial, guard) {
    this.memory.stopWatch = {
      serial,
      sentAt: guard.sentAt,
      until: guard.until,
      mayLand: guard.mayLand,
      confirmed: guard.confirmed,
      reasserts: guard.reasserts,
    };
    this.saveMemory().catch(() => {});
  }

  guardActive(serial, guardKey) {
    const key = `${serial}:${guardKey}`;
    const guard = this.guards.get(key);
    if (guard && this.mono() >= guard.until) {
      this.guards.delete(key);
      if (guard.stop && this.memory.stopWatch) {
        this.memory.stopWatch = null;
        this.saveMemory().catch(() => {});
      }
      return false;
    }
    return Boolean(guard);
  }

  /** A read of the parameters, through the guards: never lifted on an unknown value. */
  observe(serial, control, { fromCommand = false } = {}) {
    const same = (a, b) =>
      typeof a === 'number' && typeof b === 'number'
        ? Math.abs(a - b) <= CURRENT.tolerance
        : a === b;
    for (const [guardKey, value] of [
      ['mode', control.mode],
      ['current', control.currentLimit],
    ]) {
      if (!this.guardActive(serial, guardKey) || value === undefined) {
        continue;
      }
      const key = `${serial}:${guardKey}`;
      const guard = this.guards.get(key);
      if (!same(value, guard.from)) {
        guard.moved = true;
      }
      if (guard.stop) {
        // The charger read not stopped while no start left since the stop:
        // the stop did not take (or a late start of Gladys landed after it):
        // sent again, twice at most. Once a read showed it stopped, a start
        // seen afterwards came from elsewhere (the SMA app, the rotary
        // switch): left alone, unless a start of Gladys may still land.
        if (value === MODES.STOP) {
          if (!guard.confirmed) {
            guard.confirmed = true;
            this.keepWatch(serial, guard);
          }
        } else if (
          !fromCommand &&
          !this.inFlight?.startLike &&
          this.charger.lastStartAt <= guard.sentAt &&
          guard.reasserts < TIMINGS.stopReasserts &&
          (!guard.confirmed || guard.mayLand)
        ) {
          guard.reasserts += 1;
          this.keepWatch(serial, guard);
          this.reassertStop(serial);
        }
        continue;
      }
      if (guard.moved && same(value, guard.expected)) {
        this.guards.delete(key);
      }
    }
  }

  /** Sends the stop again in its own session. No read, no option. */
  reassertStop(serial) {
    if (this.charger.serial !== serial || !this.readable || this.session?.kind === SESSION.STOP) {
      // A stop is already going to the charger.
      return;
    }
    this.logger.warn('SMA EV Charger: the charger is not stopped after a stop, stop sent again');
    const generation = this.generation;
    const send = async () => {
      // Never two sessions: the read that saw it has ended; a command under way gives way.
      await this.acquire(SESSION.STOP, this.mono());
      await this.openSession(
        SESSION.STOP,
        (api) =>
          api.write(PARAMS.MODE, MODES.STOP, {
            by: this.mono() + 2 * TIMINGS.readTimeout,
            beforeSend: () => {
              if (this.charger.serial !== serial || !this.readable) {
                throw new ChargerError(ERROR_KINDS.OTHER_CHARGER, 'Not the charger');
              }
              this.charger.lastSentAt = this.mono();
            },
          }),
        { deadline: this.mono() + 3 * TIMINGS.readTimeout, generation, stopLogin: true },
      );
    };
    send()
      .then(() => this.followUp())
      .catch(async (err) => {
        if (generation !== this.generation) {
          return;
        }
        this.logger.warn(`SMA EV Charger: stop sent again failed (${errorReason(err)})`);
        // The guard keeps its watch: the next read tries again (twice at most in all).
        this.followUp();
        if (err.kind === ERROR_KINDS.RATE_LIMITED) {
          await this.rateLimited(err);
        }
      })
      .catch(() => {});
  }
}
