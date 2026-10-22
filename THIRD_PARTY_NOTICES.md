# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported from the project below, distributed under its own
license, the MIT License, whose full notice is reproduced here.

## omnikinverter (klaasnicolaas/python-omnikinverter)

<https://github.com/klaasnicolaas/python-omnikinverter>, by Klaas Schoute, the
library the Omnik integration of Home Assistant uses. Version 2.0.0 on PyPI
(2026-10-07), branch `main` at commit 6076a30.

Ported to JavaScript in `src/omnik/client.js` and `src/omnik/model.js`: the
four sources of the Wi-Fi logger and their pages (`/js/status.js`,
`/status.json?CMD=inv_query`, `/status.html`, TCP port 8899), the order and
meaning of the fields of each one (`webData` and `myDeviceArray[0]`, the
`i_*` keys, the `webdata_*` and `cover_*` variables), the units (0.01 kWh and
0.1 kWh in the js source), the spaces removed, the "day equal to total" check
of the json source, the Basic authentication with the logger's user name and
password, the binary TCP request carrying the logger's serial number and the
framing, checksum, field layout and offline values of its reply, the
"complete reply" check, the 10 s timeout, and the fixtures of its tests
(`tests/fixtures`, used in `test/fixtures/omnik.js`). Changed here: no
User-Agent of ours, a reply without inverter values (the night) is a state
rather than an error, every value is checked against a strict pattern, the
answers are bounded in size and time, every search is linear, and the logger's
id is only kept as a short fingerprint.

Its license notice, reproduced as it appears in its `LICENSE` file:

```
MIT License

Copyright (c) 2021-2026 Klaas Schoute

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

## gladys-zeversolar, gladys-imeon and gladys-p1-monitor

The integration itself (`src/app.js`: the pace, the night, the index built
from the counter of the day and the marks of the day before, the pauses, the
buttons), the plausibility guard of the energy index (`src/guard.js`, from
gladys-p1-monitor, its margin made a parameter), the cumulative index built
from a counter of the day (`src/daily.js`), the `/data` store
(`src/store.js`) and the address parser (`src/config.js`) come from the
sibling integrations
[gladys-zeversolar](https://github.com/LM1LC3N7/gladys-zeversolar) 0.1.4,
[gladys-imeon](https://github.com/LM1LC3N7/gladys-imeon) and
[gladys-p1-monitor](https://github.com/LM1LC3N7/gladys-p1-monitor), same
project, Apache-2.0.
