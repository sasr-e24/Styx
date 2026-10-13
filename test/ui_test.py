"""
End-to-end check of the web app in headless Chromium (Playwright).

  python test/ui_test.py test/fixture.bin [more.bin ...] [--shots DIR]

Serves app/ on a local port, loads the logs, and checks that:
  - the page loads with no errors and makes no requests outside its own origin
  - for each built-in preset, the browser download is byte-identical to the CLI output
  - group/parameter edits change the output, can be saved as a preset, and survive a reload
"""
import functools
import hashlib
import http.server
import os
import subprocess
import sys
import tempfile
import threading
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
args = sys.argv[1:]
shots = None
if '--shots' in args:
    i = args.index('--shots'); shots = args[i + 1]; del args[i:i + 2]
logs = [os.path.abspath(a) for a in args]
fixture = logs[0]
tmp = tempfile.mkdtemp()

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


handler = functools.partial(Quiet, directory=os.path.join(ROOT, 'app'))
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f'http://127.0.0.1:{srv.server_port}/index.html'

md5 = lambda p: hashlib.md5(open(p, 'rb').read()).hexdigest()
fails = []


def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond:
        fails.append(msg)


def cli(preset):
    subprocess.run(['node', os.path.join(ROOT, 'cli/styx.js'), '--preset', preset, '--out', tmp, fixture],
                   check=True, capture_output=True)
    return os.path.join(tmp, os.path.basename(fixture).rsplit('.', 1)[0] + f'_{preset}.bin')


def settle(pg):
    pg.wait_for_timeout(300)
    pg.wait_for_function("document.getElementById('busy').hidden", timeout=30000)


def download_first(pg):
    with pg.expect_download() as d:
        pg.click('#files [data-action=download] >> nth=0')
    p = os.path.join(tmp, 'dl_' + d.value.suggested_filename)
    d.value.save_as(p)
    return p, d.value.suggested_filename


with sync_playwright() as pw:
    b = pw.chromium.launch()
    for scheme in ('light', 'dark'):
        ctx = b.new_context(viewport={'width': 1360, 'height': 1000}, color_scheme=scheme, accept_downloads=True)
        pg = ctx.new_page()
        errors, foreign = [], []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        pg.on('request', lambda r: foreign.append(r.url) if not r.url.startswith(URL.rsplit('/', 1)[0]) and not r.url.startswith('blob:') and not r.url.startswith('data:') else None)
        pg.goto(URL)
        pg.set_input_files('#file', logs)
        pg.wait_for_function(f"document.querySelectorAll('#files [data-action=download]').length == {len(logs)}", timeout=60000)
        settle(pg)

        if scheme == 'light':
            print('presets vs CLI:')
            for preset in ('customer', 'customer-plus', 'gps-vendor', 'partner', 'no-params'):
                pg.click(f'.preset[data-id="{preset}"]')
                settle(pg)
                path, name = download_first(pg)
                check(md5(path) == md5(cli(preset)) and name.endswith(f'_{preset}.bin'), f'{preset}: browser output == CLI output ({name})')

            print('editing:')
            pg.click('.preset[data-id="customer"]'); settle(pg)
            before = pg.inner_text('#files .size >> nth=0')
            pg.check('[data-action=group][data-id=imu]'); settle(pg)
            after = pg.inner_text('#files .size >> nth=0')
            check(before != after, f'turning on IMU group changes output size ({before} -> {after})')
            check(pg.is_visible('#modified') and 'Changed from Customer' in pg.inner_text('#modified'), 'shows "changed from preset"')
            pg.check('[data-action=pgroup][data-id=GPS]'); settle(pg)
            txt = pg.text_content('#files details >> nth=0')
            check('GPS_TYPE' in txt and 'ATC_RAT' not in txt, 'GPS parameter group added, tuning params not')
            pg.fill('#preset-name', 'Test preset')
            pg.click('[data-action=save-preset]')
            settle(pg)
            p1, n1 = download_first(pg)
            pg.reload()
            check(pg.locator('.preset[data-id="custom:test-preset"]').count() == 1, 'saved preset survives reload')
            pg.set_input_files('#file', [fixture])
            pg.wait_for_function("document.querySelectorAll('#files [data-action=download]').length == 1", timeout=60000)
            settle(pg)
            p2, n2 = download_first(pg)
            check(md5(p1) == md5(p2) and n2.endswith('_test-preset.bin'), f'saved preset reproduces the same output ({n2})')

            with pg.expect_download() as d:
                pg.click('[data-action=export]')
            exp = os.path.join(tmp, 'preset.json'); d.value.save_as(exp)
            r = subprocess.run(['node', os.path.join(ROOT, 'cli/styx.js'), '--policy', exp, '--out', tmp, fixture], capture_output=True)
            out = [f for f in os.listdir(tmp) if f.endswith('_test-preset.bin') and not f.startswith('dl_')]
            check(r.returncode == 0 and out and md5(os.path.join(tmp, out[0])) == md5(p2), 'exported preset gives the same output in the CLI')
            pg.click('.preset[data-id="customer"]'); settle(pg)

        if shots:
            os.makedirs(shots, exist_ok=True)
            pg.click('[data-action=toggle-open][data-key="g:gps"]')
            pg.screenshot(path=os.path.join(shots, f'app_{scheme}.png'), full_page=True)
        check(not errors, f'{scheme}: no page errors {errors[:3]}')
        check(not foreign, f'{scheme}: no requests outside the app {foreign[:3]}')
        ctx.close()

    if shots:
        pg = b.new_page(viewport={'width': 390, 'height': 900})
        pg.goto(URL)
        pg.set_input_files('#file', [fixture])
        pg.wait_for_selector('#files [data-action=download]', timeout=60000)
        settle(pg)
        pg.screenshot(path=os.path.join(shots, 'app_mobile.png'), full_page=True)
        check(pg.evaluate('document.documentElement.scrollWidth') <= 390, 'mobile: no horizontal scroll')
    b.close()

print('PASS' if not fails else f'FAIL ({len(fails)})')
sys.exit(1 if fails else 0)
