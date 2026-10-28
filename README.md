# gladys-sma-ev-charger

Gladys Assistant external integration for the **SMA EV Charger** (EVC7.4-1AC-10,
EVC22-3AC-10) and the **SMA eCharger**, over the local web API of the charger
(HTTPS, its certificate pinned at the first connection). Unofficial, not
affiliated with SMA. **Never tested with a real charger.**

- State, vehicle plugged in, charging mode, rotary switch, status of the
  charger, power, current and voltage per phase, charge current limit.
- Energy index of the charger (kWh, never 0 nor a drop published: a value
  held is taken only by "Accept the held index", two clicks) and energy of
  the session.
- **Stop charging** always available (no option, never held back by a
  command, a pause or a failed read; kept and sent again when the charger
  cannot be reached).
- **Start charging**, the **charging mode** and the **charging current**
  only behind "Allow starting, the mode and the current" (off by default),
  decided on a fresh read, one change a minute, the current capped. Buttons
  and lists, never a switch.

User documentation: [English](docs/en.md), [français](docs/fr.md).

Ported from [pysmaev](https://github.com/alengwenus/pysmaev) (MIT) and
[ha-sma-ev-charger](https://github.com/alengwenus/ha-sma-ev-charger)
(Apache-2.0), see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Development

```bash
npm install
npm test
npm run lint
npm run format:check
```

Rules for contributors and coding assistants: [CLAUDE.md](CLAUDE.md). Plan,
decisions and what is left to check on a real charger: [TODO.md](TODO.md).

## License

Apache-2.0 (see [LICENSE](LICENSE)).
