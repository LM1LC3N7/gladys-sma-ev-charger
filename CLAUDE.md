# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

## Commands

```bash
npm install
npm test                                  # node --test (60 s per test at most)
node --test test/devices.test.js          # one file
node --test --test-name-pattern "stop"    # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/handlers.js                   SDK handlers -> SmaApp (shared with the tests)
src/app.js                        configuration, sessions, polling, device, states, status, commands
src/devices.js                    device and states of the charger (pure); feature roles are frozen
src/sma/client.js                 the SMA web API: token, measurements, parameters, a write (pure parsers)
src/sma/http.js                   one HTTPS request on its own TLS connection, pin checked first
src/guard.js                      plausibility of the energy index (from gladys-p1-monitor, as it is)
src/store.js                      /data: pin, serial, pauses, block, minute, stop kept, guards (no secret)
src/publisher.js                  states to Gladys within 300 per minute
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/i18n.js                       English and French runtime texts
scripts/cover.mjs                 cover.png generator (plain Node, no dependency)
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys (integration-sdk/testing)
test/kit/                         parts of gladys-testkit: fake servers, clocks, test certificates
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the serial number
  of the charger, never a label nor the IP. Gladys keys devices, their
  history, scenes and dashboards on them: changing one creates a new device
  and orphans the old one. The same goes for every key users store: manifest
  `config_schema`, `actions`, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log, store or show the user name, the password or
  the access token; never keep the body of an HTTP answer in an error. A
  `secret` field is "kept by Gladys in its database, never shown again", never
  described as protected otherwise.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language.
  `test/manifest.test.js` ties the manifest to the code: change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync. Files are
  UTF-8 without BOM and without control bytes (`test/encoding.test.js`).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (the TLS tests use the loopback).
- **Clocks.** Every decision runs on the monotonic clock, read once per
  decision; the wall clock only dates /data and the timestamp of a written
  value; the energy guard runs on the session clock (wall at the start of the
  process + monotonic since). Tests use the virtual clock of `test/kit` (it
  moves at every read) and one real-clock test (x20).
- **SMA EV Charger.** One session at a time on the charger, each request on
  its own connection, the certificate checked against the pin BEFORE any
  byte is written (the first pin in /data before the password leaves). Only
  `Parameter.Chrg.ActChaMod` (4718, 4719, 4721) and
  `Parameter.Inverter.AcALim` (6-32 A, whole) are ever written. "Stop
  charging" (mode 4721) needs no option and is never held back (in flight,
  the minute, a 429/5xx pause, a failed read, before the first read); not
  applied (unreachable, 429/5xx, refused credentials…), it is retried within
  its budget, then kept in /data and sent again every 30 s on its own timer,
  never dropped by the time (only a read showing it, a start of Gladys the
  charger took — 2xx, 5xx or no answer; refused, 3xx/4xx/429, it changes
  nothing —, another charger or address; a 3xx/4xx: every 5 min, given up
  after 3 identical ones to the resends of one click); with refused credentials or
  rights it waits for new ones or the button (a click: one login a minute);
  contradicted by a read within 90 s, sent again twice at most.
  Start, the other modes and the current are behind `allow_commands` (off),
  decided on a read of the same session, checked again in `beforeSend`, one a
  minute (kept in /data before the first byte); a command is a success only
  when the read right after shows the value asked. Refused credentials: no
  automatic try. Never a switch. The energy index goes through
  `src/guard.js` only.
