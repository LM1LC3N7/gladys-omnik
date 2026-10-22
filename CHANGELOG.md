# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Local reading of Omnik solar inverters through their Wi-Fi logger, as the
  omnikinverter library does, from four sources: `js` (`/js/status.js`, the
  default), `json` (`/status.json`), `html` (`/status.html`, with the
  logger's user name and password) and `tcp` (port 8899, with the logger's
  serial number). No cloud, no account, one request a minute (every 5
  minutes at night), never faster whatever asks (reconnection, save, test
  button, Discover tab, restart: the time of the last read is kept in
  `/data`).
- One device per inverter (`inverter:<serial>`; a fingerprint of the logger
  or of the address when the answer has no serial, kept once its device is
  created even if a serial appears later, with the first serial seen; any
  other serial goes to its own device): solar power, energy of the day,
  inverter awake, inverter temperature (tcp source, as a device temperature,
  never the room's). Without a serial (json), a fixed address is required and
  an answer with another rated power is refused (the test button learns a
  new one); an answer missing its serial now and then is ignored, red only
  after an hour.
- The night also when the logger answers with its serial but without power
  nor counter of the day (empty, or its "no value" 4294967295).
- A solar production index for the Gladys energy monitoring, built from the
  counter of the day with the mechanism of gladys-zeversolar 0.1.4 (the
  inverter asleep at night, the counter of the day before shown again kept
  out, small days, a drop never accepted, a margin from the peak power typed
  or learned) and checked by the guard of gladys-p1-monitor: never 0, a jump
  taken only by the "Accept the held index" button; its 30-minute production
  declared with stable ids.
- The night: three silent reads (or a logger answering without inverter) and
  the inverter is asleep: power 0, green status, no index; red only for an
  inverter that vanishes while producing, another logger at the address, a
  wrong answer, or a day of silence.
- A user name or password refused by the logger (401/403) stops the reads
  for good, kept in `/data` (a salted fingerprint of the refused set only):
  never an automatic new try; other credentials or a success of the test
  button lift it.
- 429 and 5xx: a bounded pause (1 min to 6 h) kept in `/data`. Answers bounded
  (32 KiB web, 1 KiB tcp, 10 s), no redirect followed, every field checked,
  linear parsing.
- Guides in English and French, cover image, third-party notices in the image.

[Unreleased]: https://github.com/LM1LC3N7/gladys-omnik/commits/main
