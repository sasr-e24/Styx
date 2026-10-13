# Styx

Makes ArduPilot DataFlash `.bin` logs safe to share. You pick what leaves: flight
track for a customer, receiver data for a GPS vendor, full flight data for a trusted
partner. Parameters, tuning, sensor performance and hardware identity stay home
unless you choose to include them.

Logs are processed in the browser. Nothing is uploaded, and the app makes no
requests outside its own site.

**Use it:** https://sasr-e24.github.io/Styx/ (once Pages is enabled, see below), or
open `app/index.html` directly from a checkout.

## Presets

| Preset | Keeps |
|---|---|
| Customer | GPS track and speed (first receiver, no yaw), position, height, modes, arm/disarm, events, mission |
| Customer, detailed | Customer, plus roll/pitch/yaw (no setpoints) and pack voltage, current, mAh, % |
| GPS vendor | Every GPS message from every receiver, all columns; position; attitude; board power (POWR, MCU); battery; CAN bus and serial port stats; errors; `GPS*`, `EK3_SRC*` and `CAN_*` parameters; text lines about GPS, receivers, RTK, DroneCAN, and the firmware version |
| Trusted partner | All flight data groups and board power. No parameters, text messages, links, firmware/board identity or unknown messages |
| Everything but parameters | The whole log, including unknown/custom messages, except parameters, autotune gain records (ATUN/ATDE), embedded files, and text lines that contain a parameter-style name or mention tuning or gains |

Every preset can be edited in the app: switch data groups or single messages on or
off, pick columns, keep or drop extra sensor instances, tick parameter groups or
single parameters, tick text lines. Edited setups can be saved as presets (stored in
that browser) and exported/imported as JSON to share with the team.

To add a preset everyone gets, add it to `PRESETS` in `app/catalog.js`. Which message
belongs to which data group is also set there.

Always removed, whatever the preset: embedded files (`FILE`) and any bytes that can't
be parsed.

## How it works

The output is rebuilt, not filtered in place. Styx parses the log, writes new FMT
records that describe only the kept columns, and re-encodes each kept message from
those columns. Parameters and text lines are kept per name/line. Nothing outside the
selection can reach the output.

## Command line

```
node cli/styx.js --list
node cli/styx.js --preset gps-vendor --out shared/ log1.bin log2.bin
node cli/styx.js --policy my-preset.json log.bin      # preset exported from the app
```

## Tests

```
pip install pymavlink playwright && python -m playwright install chromium
bash test/run_tests.sh [real1.bin ...]     # engine tests + every preset checked with pymavlink
python test/ui_test.py test/fixture.bin    # web app end to end
```

`run_tests.sh` builds a synthetic log (`test/make_fixture.py`), so CI needs no real
logs. For each log and preset it checks, with pymavlink as an independent parser:
the output parses; only the selected messages and columns are present; every kept
value equals the original; parameters and text lines are exactly the selected ones;
no removed parameter name, text line, embedded-file text or firmware hash appears
anywhere in the output bytes. Real logs also get a hostile copy (second GPS, second
battery, junk bytes with secret text) run through the customer presets.

## Hosting

`.github/workflows/ci.yml` runs the tests on every push and deploys `app/` to GitHub
Pages from `main` when they pass. One-time setup: repo Settings, Pages, Source:
GitHub Actions. GitHub Pages on a private repo needs a paid GitHub plan; on the free
plan the repo has to be public. The app is static, so any static host works too.
