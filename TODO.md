# TODO — SMA EV Charger v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Status

- [x] **Milestone 1 — core** (2026-10-28, lot 18): one charger by address,
      user name and password of its web interface, HTTPS with the
      certificate pinned at the first connection, one device per serial,
      state, mode, rotary switch, status, power, current and voltage per
      phase, energy index (guarded) and energy of the session, charge
      current limit; "Stop charging" always available (kept and sent again
      when not sent, sent again when contradicted); start, mode and current
      behind `allow_commands` (off); test, accept and trust buttons; docs
      en/fr, cover. Tested against a simulated charger only (the fixtures of
      ha-sma-ev-charger, a fake behind `exchange`, real TLS servers on the
      loopback).
- [ ] **Milestone 2 — real charger**: run against a real EVC22 (see "To
      check"), turn the answers (anonymized) into fixtures.
- [ ] **Milestone 3 — more**: the setpoint charging (energy + end time), the
      LED brightness, the standby disconnection (`Parameter.Chrg.StpWhenFl`),
      the manual charging release (`Parameter.Chrg.ChrgApv`, a release is an
      unlock: behind the option, never a switch), the restart of the charger.

## To check on a real charger

- That writing `Parameter.Chrg.ActChaMod` = 4721 stops a charge under way,
  how fast the measurements show it, and whether the charger keeps the mode
  after the vehicle leaves or puts back the mode of the rotary switch (the
  stop's watch would then send it again twice within 90 s).
- That 4718 (boost) starts a charge when a vehicle waits, and which modes
  `possibleValues` offers with and without a Sunny Home Manager.
- The answer of a PUT accepted (204? 200 with a body?) and refused (403 for a
  user without rights?), and of a wrong password on `/api/v1/token` (400
  `invalid_grant`, 401?); whether repeated wrong passwords lock the account
  (the reason of the block without automatic try).
- The lifetime of the token (`expires_in`), and whether a restart of the
  charger invalidates it (401, then a new token once).
- Whether `Parameter.Inverter.AcALim` is kept in flash (a write a minute at
  most is already the rule) and whether a user (not installer) may write it.
- Whether the charger serves its web API over HTTPS only, its certificate
  (self-signed, stable across firmware updates?), and the TLS versions.
- The session states seen in practice (200111-200115, 5169) and whether
  `Measurement.ChaSess.WhIn` keeps the last session until a new one starts.
- Whether the meter reading (`…TotWhIn.ChaSta`) resets at a firmware update.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag
  (`ghcr.io/lm1lc3n7/gladys-sma-ev-charger:0.1.0`); the first patch release
  gives 0.1.1. `test/manifest.test.js` checks the four agree. SDK `^0.16.0`
  (the latest published, 2026-10-25: resync with Gladys master, nothing this
  module uses changed).
- **Not in the manifest** (lot rules): `keywords` and `countries` (SMA EV
  Charger is sold in Europe mostly: DE, FR, NL… — to add when the store
  takes them). Categories `vehicles` (an EV charger) and `energy` (it
  matters for the home balance), §3 of the catalog spec.
- **References**: pysmaev 0.1.10 (MIT, alengwenus, commit 131e1eb) and
  ha-sma-ev-charger 1.4.1 (Apache-2.0, alengwenus, commit 0cb1ee1) — licenses
  read in their `LICENSE`: not GPL. Cloned read only in
  `~/code/ref/lot18/`. Ported to JavaScript (`src/sma/client.js`,
  `src/sma/http.js` on `node:tls`), no Python, no runtime dependency but the
  SDK; notices in `THIRD_PARTY_NOTICES.md`, shipped in the image with
  `LICENSE` (the standard Apache-2.0 text, no name). pysmaev's refresh token
  is not used (a new token with the credentials when the one in memory is
  old or refused), nor its writes of other parameters.
- **Neighbour modules** (read only): gladys-alfen (HTTPS charger with a
  pinned certificate, the structure, the command rules, the guard), gladys-
  peblar and gladys-keba (the commands of a charger); the session clock of
  gladys-p1-monitor and gladys-openems; the getConfig() retries of
  gladys-openems; the two clicks of gladys-p1-monitor.
- **Transport**: HTTPS only (the charger serves its web interface over
  HTTPS; ha-sma-ev-charger's plain HTTP option, for a proxy, is not kept).
  Each request is one TLS connection: connect, pin checked (nothing written
  before; the first pin written to `/data` before the password leaves, else
  refused), one request (`Connection: close`), closed. One session at a time
  on the charger (`app.session`): a poll never starts while one is open; a
  command takes the charger from a poll; a stop from anything (the request
  under way fails ABORTED, never applied, never a failure). 8 KB of headers,
  128 KB per answer, chunked bodies, no redirect. `rejectUnauthorized: false`
  only with the pin; TLS 1.2 at least, `DEFAULT@SECLEVEL=1`.
- **Certificate changed**: nothing written, `refusedPin` kept in `/data`, the
  status shows its first 8 bytes; "Trust the new certificate" in two clicks
  (3 to 60 s apart) pins exactly the fingerprint shown. A new address forgets
  the pin, the serial, the last read and a stop kept.
- **Credentials**: user name AND password required (one alone refused, said
  in the status), printable ASCII, 256 characters at most, memory only. The
  access token (memory only) is used until 90 % of `expires_in` (1 min to
  24 h, 1 h without); a 401/403 with an old token gives one new token in the
  same session; with a token just given it is "no right" (status), never a
  block. Token request answered 400/401/403: **block in /data, no automatic
  try** (stricter than gladys-alfen's 15 min / 1 h / 6 h: a charger may lock
  the account; lot rule "refus clair : aucun essai automatique"); lifted by
  new credentials (tried at once) or "Test the connection" (one try a
  minute, never sooner than the interval); a stop during a block logs in at
  most every 5 minutes after the last refusal. No hash of the password is
  kept, so after a restart of the container the block stays until one of
  these.
- **Reads**: token when needed, `measurements/live`, `parameters/search`,
  every interval (30 s by default, 15 s – 1 h). Never sooner than the
  interval (button, Discovery, `connected`, unchanged save, restart: the
  start of the last read kept in `/data` at most once a minute); only the
  reads 5 s and 20 s after a command go sooner (one series at a time). 429:
  pause 1 min – 6 h (Retry-After in seconds, or a date against the `Date`
  header of the same answer; 5 min without), 5xx: a pause of the failure
  delay (1 min at least); both persisted, bounded at a restart, on every
  path but the stop. Failures: 30 s, 1, 2, 5 min, never under the interval.
- **Identity**: one device per serial (`Parameter.Nameplate.SerNum`, lower
  case, 4–40 characters), never per IP. Another serial at the address: the
  old device becomes "not read any more"; a command for it is refused. A
  command refuses a fresh read of another serial; an unreadable serial is
  not another charger (the pin vouches). No serial: not added ("not an SMA
  EV Charger").
- **Features and units** (core `DEVICE_FEATURE_UNITS_BY_CATEGORY`): power,
  current and voltage per phase on `energy-sensor` (W/A/V); the meter reading
  of the charger (`Measurement.Metering.GridMs.TotWhIn.ChaSta`, Wh → kWh)
  **the only index** (`energy-sensor/index`), always through the guard
  (`maxKw` 25, `slackKwh` 0.5) on the session clock; the energy of the
  session on `electrical-vehicle-charge/last-charge-energy-consumption` (kWh,
  never 0: a session counter restarts, the last one stays until the new one
  delivered something); the charge current limit on
  `electrical-vehicle-charge/target-current` (A, read only); status, mode,
  rotary switch and status of the charger as text; charge stopped and error
  on `unknown/binary`. Every role always built. No
  `publishEnergyConsumption`, no daily consumption.
- **States** (`Measurement.Operation.EVeh.ChaStt`): 200111 → AVAILABLE/IDLE,
  plugged 0; 200112 → OCCUPIED, EV_CONNECTED (PAUSED_BY_CHARGER and "charge
  stopped" in the mode "Charge stop"); 200113 → OCCUPIED/CHARGING; 5169
  (locked) → IDLE, connector and plugged unknown; 200115 → FAULTED/IDLE;
  other codes → "Unknown state". Error: fault or status "alarm". Offline:
  status "Charger unreachable", connector UNAVAILABLE, other values kept.
- **Commands**: `stop-charge` and `start-charge` (`button/push`, value 1
  only), `set-mode` (`text/select`: boost, optimized, stop) and
  `set-current` (`text/select` of whole amperes, 6 A to the ceiling); never a
  switch nor a writable binary. The client refuses any other channel or
  value (4720 setpoint included).
- **Stop is protective** (no option, never held back): mode 4721 written in
  its own session, no read before (nothing "already so"), ignores the
  minute, a 429/5xx pause, a failed or hung read (the session under way is
  given up), goes before the first read after a restart to the serial kept
  in `/data` (any created device when none is kept), and with a `/data` that
  cannot be written (the first pin aside). Not sent because unreachable: new
  tries 250 ms apart within its 3.5 s, then kept in `/data` (`pendingStop`)
  and sent before the next reads (its own session, whatever pauses the
  reads), 3 tries within 15 minutes; a start that left since cancels it; a
  date in the future in `/data` drops it. Watch of 90 s after a stop: a read
  (poll or follow-up, never the read of a command) showing another mode while
  no start left since sends it again, twice at most — until a read showed it
  stopped, and afterwards only when a start of Gladys may still land (in
  flight, overtaken, unconfirmed within 90 s, kept in `/data`).
- **Start, mode, current** (`allow_commands`, off by default, only `true`
  allows): value validated strictly; the option checked on arrival and in
  `beforeSend` with the generation, the target, the pause, the block, the
  deadline and the ceiling; decided on a read of the same session (start and
  mode: measurements and parameters; current: parameters), never memory; a
  missing value refuses; start refused without a vehicle, on a fault, a lock
  or an unknown state; a mode the charger does not list in `possibleValues`
  refused; nothing sent when already so (unless a guard holds); the minute
  kept in `/data` BEFORE the first byte (a failed save refuses; given back
  when nothing left or the charger refused). Ceiling: the lowest of
  `max_current` (16 A, 6–32 A), the `max` of `AcALim` and the rated current;
  floor: the `min` of `AcALim`, never under 6 A.
- **Outcomes**: sent by 3.5 s or refused unsent ("too slow", "a stop arrived
  meanwhile", "not sent"), answered by 4.3 s. 2xx then a read in the same
  session (400 ms left at least): the value asked → success; the value
  before → "not applied yet" + guard + reads 5 s and 20 s; nothing read →
  "sent, without confirmation". 4xx on the write → refused (the minute given
  back); 429 → pause; silence, 5xx, cut after the bytes left → "sent, without
  confirmation" + guard + reads. The ack never waits for Gladys.
- **Late answers**: a poll read begun before a command left is quarantined;
  a poll given up for a command is dropped; the read of a command is applied
  only when no command left during it; an answer of an old configuration
  (generation) publishes nothing.
- **Freshness**: a reconnection republishes the device, the badge and the
  status, never the old values (the core's cache cleared, the next read sends
  them all); a device created gets the values of a read of the last two
  intervals only. The charger gives no reading time (its channel times are
  the last change): no deduplication on a source time.
- **getConfig()** failing in `connected`: asked again after 5 s, 15 s, 30 s,
  then every minute, without end, the status saying so; the configuration
  read before keeps working meanwhile (the stop goes). Saves in a row are
  applied one after the other (the last one wins); a save cancels a retry.
- **/data**: wall dates on disk, monotonic dates in memory (`src/store.js`),
  bounded when read back (a wait never longer than its maximum, a past date
  never in the future, a stop kept "in the future" dropped). Unreadable is not
  empty: nothing pinned nor sent (the stop included), read again at each
  interval; never written over. Written at a clean shutdown.
- **Hostile answers**: only own fields of plain objects, the known channels
  of `IGULD:SELF` in a `Map`, numbers exact (`''`, a text, `null` are
  unknown, never 0), texts bounded without control characters, at most 1000
  channels and 32 possible values. Logs carry error kinds and HTTP statuses
  only.
- **One charger** per integration in v1 (pysmaev and Home Assistant take one
  host per entry): a scene on several chargers, a target in 5xx not stopping
  the others, do not apply.
- **Demo files of the template** (`src/devices/*`, `scenes.js`, `widgets.js`,
  `weather.js` and their tests) deleted with `git rm`.
