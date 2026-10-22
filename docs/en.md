# Omnik for Gladys Assistant

Unofficial connector, not affiliated with Omnik. It reads your Omnik solar
inverter on your home network, through its Wi-Fi logger, without any cloud and
without any account.

**Never tested with a real Omnik inverter**: it was built from the
omnikinverter library (the one Home Assistant uses) and the examples of its
tests. Please report what you see (see "Feedback" below).

## What you get

One Gladys device per inverter, named after its serial number:

| Feature                       | What it is                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| Solar production (W)          | the power the inverter produces now; 0 at night                                         |
| Solar energy of the day (kWh) | the counter of the day of the inverter, as it gives it                                  |
| Solar production index (kWh)  | a cumulative index for the Gladys energy monitoring (production per half hour, revenue) |
| Inverter awake                | 1 while the inverter produces or is ready, 0 asleep (the night)                         |
| Inverter temperature (°C)     | only with the tcp source (the web pages do not give it)                                 |

Read-only: the integration never sends a command to the inverter. The
lifetime counter of the inverter is not published (see "The energy index").

## Setting it up

1. Find the IP address of the inverter's Wi-Fi logger in your router (it shows
   up as a device of your network). Give it a fixed address if you can.
2. In Gladys, open the integration, enter the address (by day: at night the
   inverter sleeps and does not answer), choose the source, and save:
   - **js** (default): the page `/js/status.js`, given by most loggers;
   - **json**: the page `/status.json`; some loggers give no serial number in
     it (the device is then named after a fingerprint of the address: a new
     address makes a new device; prefer js if it works);
   - **html**: the page `/status.html`, which always needs the user name and
     password of the logger's web page (often admin);
   - **tcp**: port 8899, which needs the serial number of the Wi-Fi logger
     (digits only, on its label or in its web page; not the serial of the
     inverter). It also gives the temperature of the inverter.
     If the status says the answer is not the status of an Omnik inverter, try
     another source.
3. The user name and password, when given, are sent to the js and json sources
   too (some loggers ask for them). The password is kept by Gladys in its
   database, never shown again, and sent only to the logger, in Basic auth
   over plain HTTP on your network (the logger has no HTTPS).
4. Open the "Discover" tab and create the device. Its values come at the next
   read (within a minute by day).
5. Optional but recommended: enter the peak power of your panels (kWp, on the
   installer's invoice). It bounds what the energy index may take between two
   reads. Left empty, it is learned from the power the inverter reaches over a
   week (30 kW until then, which lets more odd readings through). Never enter
   less than the real peak power (a long silence at noon could then lose the
   rest of the day): in doubt, leave it empty.

The "Test the connection" button reads the inverter if a read is due, and
otherwise tells the last read: the integration never reads more than once a
minute, whatever asks.

## A refused password

When the logger refuses the user name or the password (HTTP 401 or 403), the
integration stops reading with them, for good, even after a restart: a wrong
password is never tried again on its own. Enter the right ones and save (the
reads go on at their pace), or, if the logger accepts them again, click "Test
the connection": one read, and the refusal is lifted on success. Only a salted
fingerprint of a refused set is kept, erased at the first success; never the
password.

## The night

An Omnik inverter is powered by its panels: at sunset it stops, and its Wi-Fi
logger either answers without production or goes silent. That is not an
error: after three silent reads (or at once when the logger says so), the
inverter is "asleep", its power goes to 0, the status stays green and says so,
and it is read every 5 minutes until it wakes up. The status turns red if the
inverter vanishes (or its logger answers without it) while producing 50 W or
more, if another Wi-Fi logger answers at the address, if the answer is not the
status of an inverter, or if there is no reading for more than a day; after an
hour of silence it is considered asleep anyway.

## The energy index

The inverter gives a counter of the day (it starts again every morning, to
0.01 kWh) and a lifetime counter (to 0.1 kWh, not reliable on every
firmware), while the Gladys energy monitoring counts the rises of a cumulative
index. The integration builds that index from the counter of the day, with the
mechanism of the Zeversolar integration: the index goes on from its last value
and adds what the counter of the day adds. It never goes back to 0 and never
drops: a new day (the counter back to 0 in the morning) leaves it where it
was. When the inverter shows the counter of the day before again (at sunrise,
or after a restart during the day), that value is kept out of the index and
out of the energy of the day. Doubts are settled on the side of counting less:
a reboot of the inverter that really resets its counter during the day, a
counter that jumps (the rest of that day may then be lost), hours without
reads around the change of day, a wall clock set wrong.

Risk left (it would count too much): a value of the day before shown again
more than 0.1 kWh from the last value read, above or below, or any wrong
reading that fits within the peak power of the installation since the last
read. Entering the peak power keeps that margin small. And the day before
shown again less than 0.1 kWh above today's counter may be taken: 0.1 kWh at
most.

The index also goes through a guard: a jump of the index itself is held back,
shown in the integration status, and only taken when you click "Accept the
held index" in the configuration (it is then counted at once). A drop of the
index is never accepted: it corrects itself, the index goes on once the
counter is back above it. Saving the configuration never accepts anything.

## Limits

- One inverter per logger and per integration.
- Production after the local midnight (far north in June, or a Gladys time
  zone east of the house): the reset of the counter falls on the same local
  day and that day is undercounted.
- Some loggers keep showing the last values at night: the power then stays
  at its last value until the logger goes silent.
- The integration needs Gladys 5.2.0 or later.

## Privacy

Nothing leaves your network: the integration only talks to the address you
entered, with one small request a minute (every 5 minutes at night). Of the
logger's id only a short fingerprint is kept (to tell one logger from
another). The user name and password are never logged, shown or written in
`/data`.

## Feedback

Issues and pull requests: <https://github.com/LM1LC3N7/gladys-omnik>. If you
own an Omnik inverter, the text of `http://<address>/js/status.js` (by day and
at night, with the serial numbers hidden) helps a lot.
