# gladys-omnik

Unofficial [Gladys Assistant](https://gladysassistant.com) integration for
**Omnik solar inverters**, not affiliated with Omnik. It reads the inverter's
Wi-Fi logger on your network (`/js/status.js`, `/status.json`, `/status.html`
or TCP port 8899; no cloud, no account) once a minute: solar power, energy of
the day, temperature (tcp source), and a guarded solar production index for
the Gladys energy monitoring, built from the counter of the day. The night is
handled (the inverter sleeps: power 0, no error). Read-only.

**Never tested with a real Omnik inverter.** Built from the
[omnikinverter](https://github.com/klaasnicolaas/python-omnikinverter) library
(MIT, see `THIRD_PARTY_NOTICES.md`), the one Home Assistant uses; the night and
the energy index are those of
[gladys-zeversolar](https://github.com/LM1LC3N7/gladys-zeversolar) 0.1.4.

- User guide: [English](docs/en.md), [français](docs/fr.md)
- Changes: [CHANGELOG.md](CHANGELOG.md)
- What is left to check: [TODO.md](TODO.md)
- Rules for contributors: [CLAUDE.md](CLAUDE.md)

## Development

```bash
npm install
npm test
npm run lint
npm run format:check
npm run audit
npm run cover        # regenerates cover.png (800 x 534, plain Node)
```

Node 22 or later. The only runtime dependency is
`@gladysassistant/integration-sdk`.

## License

Apache-2.0, see `LICENSE` and `THIRD_PARTY_NOTICES.md`.
