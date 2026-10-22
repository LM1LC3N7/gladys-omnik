# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

It reads an **Omnik solar inverter** through its Wi-Fi logger on the home
network, from one of four sources (`js`: `GET /js/status.js`, the default;
`json`: `GET /status.json?CMD=inv_query`; `html`: `GET /status.html` with
Basic auth; `tcp`: port 8899 with the logger's serial number). No cloud. The
sources and their fields are ported from
[omnikinverter](https://github.com/klaasnicolaas/python-omnikinverter) (Klaas
Schoute, MIT, see `THIRD_PARTY_NOTICES.md`). Unofficial: not affiliated with
Omnik. **Read-only**: never `onSetValue`.
Siblings: `gladys-zeversolar` 0.1.4 (the app, the night, the index built from
the counter of the day, taken as it is), `gladys-imeon` (the daily index),
`gladys-p1-monitor` (the guard).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run audit                             # npm audit --omit=dev
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run cover                             # cover.png, 800 x 534, plain Node
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/app.js                        OmnikApp: the pace, the night, the index, pauses, refused credentials, buttons
src/omnik/client.js               the only network access (one GET or one tcp request, bounded, our error codes)
src/omnik/model.js                the answers of the four sources -> values (pure)
src/daily.js                      a cumulative index built from a counter of the day (gladys-zeversolar, pure)
src/guard.js                      plausibility of an energy index (gladys-p1-monitor, pure)
src/store.js                      what /data keeps across restarts
src/devices.js                    the device, feature keys, states (pure)
src/config.js                     the form, normalized; the fingerprint of refused credentials
src/constants.js                  pages, pacing, limits, manifest keys
src/i18n.js                       runtime texts (en/fr)
scripts/cover.mjs                 the cover image
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys, a fake logger, a virtual clock
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **Energy monitoring**: `production_index` (`energy-production-sensor` /
  `index`, with its `thirty-minutes-production` declared with UUID v5 ids) is
  the only index. It is built from the counter of the day by `src/daily.js`
  and passes `IndexGuard` (`src/guard.js`): never 0, a drop and a jump never
  confirmed by repetition nor by time; a jump taken only by the
  `accept_held_index` action, bounded to the value shown; a drop NEVER
  accepted. The counter of the day before shown again is kept out by
  `keptOut` in `src/app.js`. The inverter's lifetime counter is never
  published (it would be counted twice). `energy_today` stays the inverter's
  counter (`daily-production`): never an index, never
  `publishEnergyConsumption`. Do not change `src/daily.js`, `src/guard.js` or
  `keptOut` / `noteNewDay` without the same change in gladys-zeversolar /
  gladys-imeon / gladys-p1-monitor and a review.
- **Credentials refused**: a 401/403 is final and kept in `/data` (a salted
  fingerprint of the refused set only, erased at the first success): no timer,
  no automatic read while the form gives the same set; only the test button
  reads (at the pace) and a success lifts it. The password stays in the client
  object and the Authorization header: never in a log, a status, an error,
  `/data` or Discovery. Describe the password field as "kept by Gladys in its
  database, never shown again".
- **The night is not an error** (see TODO.md "Decisions").
- **The pace**: never two reads less than the interval apart, whatever asks;
  the time of the last read is in `/data`. Never add a read path that skips
  `dueAt()`.
- **Late answers**: every await in a read is followed by `gone()`; an old
  session never publishes nor sets a status.
- **Pauses**: 429/5xx pause from 1 min to 6 h, kept in `/data` (end capped
  when read back); a reconnection clears neither a pause, a refusal nor the
  client.
- **Never a text of the logger in a message**, never a URL in the logs; the
  logger's id only as a fingerprint.
- **External ids are forever**: `inverter:<id>` (`identityOf` in
  `src/app.js`), the `FEATURE` keys of `src/devices.js`, the manifest keys and
  actions. The device has the same features for every inverter and every
  source: a new feature must be added for all, never removed.
- **The container rootfs is read-only.** Write only under `/data`:
  `src/store.js` keeps `/data/omnik-state.json`.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language.
  `test/manifest.test.js` ties the manifest to the code.
- **User-facing text** is bilingual (English and French): runtime messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync. Files are
  UTF-8 without BOM nor control bytes (`test/encoding.test.js`, sources
  included).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.

## CI and pushes

- Group the commits and push **at most once a day**, unless the maintainer
  explicitly asks otherwise: the GitHub Actions quota is limited.
- If every CI job fails in under 2 seconds, the quota is exhausted: it is not
  a bug in the code.

## Checking an answer against a real inverter

By day, on the same LAN as the logger:

```bash
curl -s "http://192.168.1.70/js/status.js"; echo
curl -s -u admin:<password> "http://192.168.1.70/status.html"; echo
```

Hide the serial numbers (and never paste a password) before the answer
becomes a fixture.
