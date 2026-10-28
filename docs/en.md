# SMA EV Charger

Shows an **SMA EV Charger** (EVC7.4-1AC-10, EVC22-3AC-10) or an **SMA
eCharger** in Gladys through the local web API of the charger, without any
cloud. Unofficial integration, not affiliated with SMA. **Never tested with a
real charger**: it was built from the open-source libraries pysmaev and
ha-sma-ev-charger (used by Home Assistant) and tested against a simulated
charger. Feedback is welcome.

## What you get

One device per charger (keyed by its serial number), with:

- status (no vehicle, vehicle plugged in, charging, charge stopped, charging
  station locked, charger fault), connector and charging state, vehicle
  plugged in, error reported, status of the charger, rotary switch;
- charging mode (boost charging, optimized charging, charging with setpoint,
  charge stop) and "charge stopped";
- power, current and voltage per phase;
- the **energy index** of the charger (kWh, its meter reading), for the energy
  tab of Gladys, and the **energy of the session** (kWh);
- the charge current limit (A);
- **Stop charging** (button), **Start charging** (button), **Set the
  charging mode** (list) and **Set the charging current** (list).

No switch: a "turn everything off" (a voice assistant, a scene) can never
start or stop a charge by mistake.

## Setup

1. Give the charger a fixed IP address in your router.
2. Create a user in the web interface of the charger if needed. To read and
   set everything, the user must be an **installer or administrator**
   (as Home Assistant says): with fewer rights the charger may refuse some
   values or the commands, which the status then says.
3. In Gladys, enter the address (an IPv4 address or a host name, optionally
   `:port`, 443 by default), the **user name and the password** (both are
   needed: one alone is refused), save.
4. Open the **Discovery** tab and add the charger.

The password is kept by Gladys in its database, never shown again, and sent
only to the charger, over HTTPS, once its certificate matched the one pinned
at the first connection. It is never written in the logs, in `/data` or in a
status, and neither is the access token the charger gives.

### The certificate of the charger

The charger serves a self-signed certificate. At the first connection its
SHA-256 fingerprint is pinned (kept in `/data`) **before** the password is
sent; afterwards every connection is checked against it before any byte is
written. If the certificate changes (charger replaced, firmware update), the
integration sends nothing (the password neither) and the status shows the
start of the new fingerprint. Compare it with the one your browser shows on
the web interface of the charger, then click **Trust the new certificate**
twice: the first click shows the whole fingerprint, a second click 3 to 60
seconds later pins exactly that one. TLS 1.2 at least.

## Reads

The charger is read every refresh interval (30 s by default, 15 s to 1 h):
an access token when the one in memory is old (it is used until 90 % of its
life, one hour by default), the measurements, then the parameters. Each
request has its own connection, closed right after. Never sooner than the
interval: the **Test the connection** button, the Discovery tab, a
reconnection to Gladys, a configuration saved unchanged or a restart do not
read sooner (only the two reads 5 s and 20 s after a command, and the read
right after new credentials or a certificate trusted by you, do).

- **429** (the charger asks to slow down): pause of the Retry-After, 1 min
  to 6 h (5 min without one), kept in `/data`; **5xx**: a pause of the
  failure delay (1 min at least). Nothing but "Stop charging" is sent during
  a pause.
- **Refused credentials** (the token request answered 400, 401 or 403): kept
  in `/data`, and **no automatic try any more** (a charger may lock the
  account after a few refused passwords). Saving other credentials tries at
  once; **Test the connection** tries once more, at most once a minute.
- A value the charger refuses to give with a token it has just given (401 or
  403): the user lacks the rights; it is not a refused password.
- Unreachable: new tries after 30 s, 1, 2, then 5 min, never sooner than the
  interval.

## Commands

### Stop charging

**Stop charging** (and the mode **Charge stop** of the list) sets the
operating mode of the charger to "Charge stop". It needs no option and is
never held back: not by a command under way (it takes the charger at once,
and a start, a mode or a current not sent yet is dropped), not by the minute
between two changes, not by a 429 or 5xx pause, not by a read that fails or
hangs (it needs no read), not before the first read after a restart (the
serial of the charger is kept in `/data`), not by a `/data` that cannot be
written. It stays until a start (from Gladys with the option, from the SMA
app, or with the rotary switch): **a forgotten stop may prevent the next
charge**.

When the charger cannot be reached, the stop is tried again within its
time (250 ms apart), then kept in `/data` and sent again before the next
reads, 3 times at most within 15 minutes (a start sent from Gladys meanwhile
cancels it). After a stop, the reads of the next 90 seconds watch the
charger: one that does not show "Charge stop" while no start left Gladys
since sends the stop again, twice at most; once a read showed it stopped, a
start seen afterwards (from the SMA app) is left alone, unless a start sent
from Gladys just before the stop may still land.

The stop is refused only:

- when the configuration was never read from Gladys (it is asked again
  without end; after a reconnection, the configuration read before keeps
  working);
- without a valid address, user name and password;
- when `/data` cannot be read (the pinned certificate is unknown);
- for a device that is not the charger at the address (another charger read
  there);
- when the certificate of the charger changed (see above), or when the first
  certificate could not be kept in `/data` (the password is not sent);
- less than 5 minutes after refused credentials (a refused password is never
  sent again in a loop), or when the charger refuses the credentials;
- when the configuration changed during the command;
- when the charger refuses the write itself (HTTP 4xx: rights of the user).

### Start, mode and current (option)

**Start charging**, **Set the charging mode** (boost or optimized charging)
and **Set the charging current** are **off by default**: turn on "Allow
starting, the mode and the current" in the configuration. Then:

- each command reads the charger first (in the same session) and is decided
  on that read, never on the values kept in memory; a value it needs that is
  missing refuses it;
- "Start charging" sets boost charging; it is refused without a vehicle
  plugged in, on a fault, a locked charger or an unknown state;
- "Optimized charging" is refused when the charger does not offer it (it
  needs an energy manager such as the Sunny Home Manager). Charging with a
  setpoint (an energy and an end time) is shown, not set;
- the current is a whole number of amperes from 6 A (or the minimum of the
  charger) to the lowest of the ceiling of the configuration (16 A by
  default, 32 A at most), the maximum the charger gives for its charge
  current limit, and its rated current;
- one start, mode or current change a minute (kept in `/data` before the
  command leaves: a `/data` that cannot be written refuses it);
- the option, the deadline and the ceiling are checked again right before
  the command leaves; a stop arriving meanwhile wins;
- refused during a 429/5xx pause or with refused credentials.

### Answers

Every command leaves within 3.5 s of the click or is refused **not sent**.
A command the charger accepted is confirmed by a read right after it: the
value asked read back is a success; the value before still read is "not
applied yet" (checked again 5 and 20 seconds later); a command that may have
reached the charger without an answer is "sent, without confirmation". The
charger refusing the command (4xx) says so.

## Energy

The energy index is the meter reading of the charger (kWh). A value of 0 or
a drop is **never** published, nor a jump larger than the charger can
deliver (25 kW on average since the last value, plus 0.5 kWh): the value is
held, the status and the badge of the device say so, and Gladys keeps the
last value. **Accept the held index** takes it, in two clicks: the first one
lists the value held, a second one 3 to 60 seconds later accepts exactly
that (for a meter reset or replaced). The guard runs on a clock that a wall
clock set by NTP does not move. The energy of the session restarts at each
session: it is never published as 0 (the last session stays shown until the
new one has delivered something).

Note: the charger is behind your main meter. If Gladys already counts the
whole home, the index of the charger is a part of it, not an addition.

## Limits

- One charger per integration. The charging mode setpoint, the LED
  brightness, the standby disconnection, the manual charging release and
  the restart of the charger are not handled.
- A stop sent before the first read after a restart needs the configuration
  from Gladys (the password is never kept in `/data`).
- Freshness relies on the reads: the charger gives no reading time.
- `/data` that cannot be read stops everything (nothing is pinned again
  blindly); it is read again at each interval.
- Never tested with a real charger: the answers of a real one (the
  operating modes offered, the rights of each user, the lifetime of the
  token) may differ.
