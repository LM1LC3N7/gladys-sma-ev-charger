# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`).

## pysmaev

Its SMA client (`src/sma/client.js`, the routes, request bodies, channel ids,
operating modes, session states and status codes of `src/constants.js`) is a
JavaScript port of parts of **pysmaev** (<https://github.com/alengwenus/pysmaev>,
version 0.1.10, commit 131e1eb of 2026-07-12), the Python library for the SMA
EV Charger: the token request with the credentials (form,
`grant_type=password`), the bearer token, the live measurements and the
parameters of the component `IGULD:SELF`, a parameter written with a
timestamp, the measurement and parameter codes. No Python code runs here and
pysmaev is not a dependency. Its license:

```
The MIT License (MIT)

Copyright (c) 2023 alengwenus

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## ha-sma-ev-charger

The choice of the channels read and written (`src/constants.js`), the
mapping of the operating modes, the session states, the rotary switch and
the status codes to names (`src/i18n.js`), the parsing of the answers
(`src/sma/client.js`) and the two answers of `test/fixtures/` (copied as
they are from its `tests/fixtures`) come from **ha-sma-ev-charger**
(<https://github.com/alengwenus/ha-sma-ev-charger>, version 1.4.1, commit
0cb1ee1 of 2026-09-17), the Home Assistant integration for the SMA EV
Charger by alengwenus, licensed under the Apache License 2.0 (the same text
as `LICENSE`; it ships no NOTICE file). Changes: ported to JavaScript, the
modes and the current written only behind the option of this integration
(the stop excepted), never a switch.

## gladys-testkit

`test/kit/` holds parts of gladys-testkit (fake servers on the loopback,
virtual and real clocks, the two test certificates), Apache License 2.0, the
same text as `LICENSE`.

## Code of sibling Gladys integrations

`src/guard.js` is taken as it is from gladys-p1-monitor (through
gladys-alfen, limits as parameters); `src/sma/http.js` (the answer parser,
the TLS connection checked before any byte), `src/publisher.js` and the
command rules of `src/app.js` follow gladys-alfen; all are Apache License
2.0 integrations of the same author.
