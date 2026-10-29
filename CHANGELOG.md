# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-29

### Added

- First version: an SMA EV Charger or eCharger read over its local web API
  (HTTPS, certificate pinned at the first connection): state, charging mode,
  power, current and voltage per phase, energy index (guarded) and energy of
  the session, charge current limit.
- "Stop charging" always available; "Start charging", the charging mode and
  the charging current behind an option, off by default.
- "Test the connection", "Accept the held index" and "Trust the new
  certificate" buttons.
- A stop not applied (charger unreachable, 429 or 5xx, refused credentials)
  is kept and sent again every 30 seconds until the charger takes it.

[Unreleased]: https://github.com/LM1LC3N7/gladys-sma-ev-charger/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-sma-ev-charger/releases/tag/v0.1.1
