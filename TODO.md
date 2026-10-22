# TODO

## Before announcing

- [ ] Test on a real Gladys 5.2+ with a real Omnik inverter (ideally one
      logger of each family: js, json, html, tcp): test button, device
      creation, the night, a sunrise, the production the core derives from
      the index.
- [ ] Test the Docker image (no Docker on the development PC yet).
- [ ] Run the store validator (`npx github:GladysAssistant/integration-store .`):
      the development agent could not run it.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store
      (after the first release: the store validator needs the GHCR image).

## To confirm on a real inverter (built without one)

- [ ] The night of each source: does the logger go silent (powered by the
      inverter), answer with empty fields (read as "asleep"), or keep the last
      values (the power then stays at its last value; the counter of the day,
      unchanged, moves nothing, and after our midnight it is kept out as "the
      day before" by `keptOut`)?
- [ ] The counter of the day: back to 0 at sunrise (or at the inverter's
      midnight)? Shown again from the day before when the inverter wakes up?
      Reset by a reboot during the day?
- [ ] The json source without `i_sn` (the library's fixture): the device is
      `host-<fingerprint of the address>`; a new address is a new device.
      Does any json firmware give `i_sn`?
- [ ] The json "day equal to total" answer (the library refuses it) is read as
      "asleep": seen at night only?
- [ ] Which loggers ask for Basic auth on js and json (the library sends it
      when given), and whether a refused password is 401 or 403 everywhere.
- [ ] The tcp source: the logger serial in the reply header equals the one
      sent (it is the logger's fingerprint here); the logger closes or keeps
      the connection after its reply (we close it at once).
- [ ] The peak power typed lower than the real one narrows the margin (as
      gladys-zeversolar review 2, m4): documented, "in doubt, leave it empty".
- [ ] Production after the local midnight and a wall clock set wrong: the
      approved gladys-zeversolar / gladys-imeon behaviour (less), for the
      record.

## Decisions

- **Versions**: 0.1.0 set once by hand when leaving the template (package,
  lock file, manifest, image tag `ghcr.io/lm1lc3n7/gladys-omnik:0.1.0`), as
  for the sibling integrations; the Release workflow owns them from now on
  (the first patch release gives 0.1.1).
- **Reused project**: omnikinverter (Klaas Schoute, MIT, 2.0.0 on PyPI,
  `main` at commit 6076a30), cloned read-only in `_ref/omnikinverter`, ported
  to JavaScript: the four sources, their fields and units, the Basic auth,
  the TCP request and the framing of its reply, the timeout, the fixtures of
  its tests. Full notice in THIRD_PARTY_NOTICES.md, copied into the image.
  The SDK stays the only runtime dependency. The template's demo files were
  removed with `git rm` (they stay in the history).
- **Taken from gladys-zeversolar 0.1.4 as it is** (the lot 12 lesson "index
  built from a counter of the day: Omnik, Hypontech"): `src/app.js` (pace,
  night, `keptOut` / `noteNewDay` with the mark of the day before dated by
  `daily.window(now).key`, the symmetric 0.1 kWh band, the slow rise never
  kept out, the small days `max(last - 0.1, last / 2)`, a drop of the built
  index never accepted, the margin from the peak power typed or learned,
  bounded 2 to 30 kW, aberrant powers above 25 kW ignored, the margin of one
  read widened by a plausible power), `src/daily.js` (only its comments name
  Omnik), `src/guard.js` (gladys-p1-monitor's, unchanged), `src/store.js`,
  the address parser, and their tests (`test/daily.test.js`,
  `test/guard.test.js`, `test/review1.test.js`, `test/earlyMidnight.*.test.js`:
  the inverter's midnight ahead, the change of hour, an outage then the day
  before shown again, small days, steps), replayed here through the js
  source. Only the reading of the logger and the refused credentials are new.
- **Index from the counter of the day, not from the lifetime counter**: the
  lifetime counter has 0.1 kWh steps (0.01 kWh for the day), is
  firmware-dependent (the Solis-branded fixture shows 44.0 kWh total for
  9.80 kWh today) and is absent at night on most sources; the brief of lot 13
  asks for the zeversolar mechanism. It is NOT published either: the core
  counts every `index` (and `energy-sensor/energy`) it receives, a second one
  would count the production twice, and the core has no type for a counter
  it must not count.
- **Read-only (v1)**: no `onSetValue`; the library has no command anyway.
- **External id** (forever, see `identityOf` in src/app.js):
  `inverter:<serial>` (the serial of the answer, checked
  `[A-Za-z0-9_-]{4,40}`), one inverter per integration; else, when the device
  known so far has a real serial, the reading is refused (`no_serial`, red,
  nothing written: a serial unreadable once is never "another inverter");
  else `inverter:logger-<12 hex>` (the fingerprint of the logger's id: html
  `cover_mid`, the tcp reply's logger serial); else
  `inverter:host-<12 hex>` (a fingerprint of the address: the json source
  without `i_sn`; a new address is then a new device, documented). The serial
  is in the same answer as the values: a DHCP swap or another inverter at the
  address never writes into the old device. The id is kept in `/data` so
  that the created device is offered at a restart by night.
- **Sources**: `js` by default (most loggers, the library's default). The
  user name and password are sent to js and json when given (the library
  does), required by html. The tcp port is 8899 unless the address gives
  another one.
- **Credentials refused** (lot 12 lesson): a 401 or 403 is final and kept in
  `/data` as `{ fp }`, a salted SHA-256 fingerprint (random salt in `/data`)
  of source, user name and password: never of a set that worked, erased at
  the first success. While the form gives the same set, no timer is set and
  no read is made (reconnections, saves and restarts included); other
  credentials (another fingerprint) read again at the pace; the test button
  makes one read when one is due and lifts the refusal only on success. The
  password lives in the client object only (a closure), in the Authorization
  header of the request to the logger; never in a log, a status, an error,
  `/data` or Discovery (tested). Plain HTTP: the logger has no HTTPS, said in
  the manifest and the docs.
- **The night** (gladys-zeversolar rules): a logger answering without
  inverter values (js / html fields empty, json day equal to total, tcp
  inverter not active) is asleep at once after a power under 50 W; after 50 W
  or more it is red ("the logger answers without its inverter") and asleep
  after an hour. A logger is told by a 12-hex fingerprint of its id (html,
  tcp; kept in /data with the serial): a page without inverter from another
  logger writes nothing into the device and is red. No answer three reads in a
  row with a last power under 50 W, or for an hour whatever the power, is
  asleep. Red: an inverter that vanishes producing 50 W or more (retries 1
  min doubled to 15 min), a wrong answer, or no reading for more than a day.
- **Pace, late answers, 429/5xx**: as gladys-zeversolar (one timer, one read
  at a time, the time of the last read in `/data` before the request, a late
  answer of an old session publishes nothing and sets no status, pause from
  Retry-After or 1 min doubled, 1 min to 6 h, capped when read back). A new
  session is any change of address, source, user name, password or logger
  serial.
- **Hostile answers**: web bodies read into one 32 KiB buffer allocated once,
  tcp replies into one 1 KiB buffer, 10 s for the whole answer, no redirect
  followed; every search is a linear `indexOf`, the js fields capped at 64,
  every value against a strict pattern, own keys only in the json, nothing
  read as 0 by default; tcp framing, checksum, separator and the serial twice
  checked, trailing 0xFF accepted only after a reply.
- **States**: `publishChangedStates` with a 10-minute heartbeat: at most 5
  states a minute, far below the 300 states a minute of Gladys. No scene
  event (`publishSceneEvent` is never called).
- **Units**: W and kWh (energy-production-sensor), °C (temperature-sensor),
  none for the awake flag: all in `DEVICE_FEATURE_UNITS_BY_CATEGORY`.
- **No custom User-Agent**, no imitation: Node's own fetch and sockets.
- **Gladys version**: `>=5.2.0`, like the other energy integrations.

## Ideas

- The alarm code (`i_alarm`, `webdata_alarm`, field 8): its meaning is not
  documented (the library's fixtures show F13/F23 while producing); a fault
  flag once confirmed on a real inverter.
- The Wi-Fi signal (js `m2mRssi`, html `cover_sta_rssi`).
- Several inverters on one logger (`myDeviceArray[1]`), once seen.
