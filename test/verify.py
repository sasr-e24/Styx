"""
Independent check of a Styx output against its original, using pymavlink's parser.

  node cli/styx.js --preset X --explain original.bin > expect.json
  python test/verify.py original.bin output.bin expect.json [--secret TEXT ...]

expect.json is what the policy should keep for this log (messages+columns, parameter
names, text lines). Checks:
  1. pymavlink parses the output.
  2. Only expected message types are present, each with exactly the expected columns.
  3. Every kept value equals the original (first instance only where the policy says so).
  4. PARM and MSG hold exactly the expected parameters and text lines.
  5. No removed parameter name, removed text line, embedded-file text, firmware hash or
     --secret string appears anywhere in the output bytes.
Exit code 0 = pass.
"""
import json
import math
import re
import sys
from pymavlink import DFReader

TABLES = {'FMT', 'FMTU', 'UNIT', 'MULT'}


def norm(v):
    # NaN != NaN, so compare NaNs as a marker
    return 'nan' if isinstance(v, float) and math.isnan(v) else v


def read(path):
    r = DFReader.DFReader_binary(path, zero_time_base=True)
    out = []
    while True:
        m = r.recv_msg()
        if m is None:
            return out
        out.append(m)


def main():
    argv = sys.argv[1:]
    secrets_extra = []
    while '--secret' in argv:
        i = argv.index('--secret')
        secrets_extra.append(argv[i + 1])
        del argv[i:i + 2]
    orig_path, out_path, expect_path = argv
    exp = json.load(open(expect_path))
    msgs, params, texts = exp['messages'], set(exp['params']), set(exp['texts'])

    fails = []
    orig = read(orig_path)
    out = read(out_path)
    out_types = {m.get_type() for m in out}
    allowed = TABLES | set(msgs) | ({'PARM'} if params else set()) | ({'MSG'} if texts else set())
    extra = out_types - allowed
    if extra:
        fails.append(f'unexpected message types: {sorted(extra)}')

    for name, rule in msgs.items():
        cols, inst = rule['cols'], rule['instCol'] if rule['primary'] else None

        def rows(src):
            return [tuple(norm(getattr(m, c, None)) for c in cols) for m in src
                    if m.get_type() == name and (inst is None or getattr(m, inst) == 0)]
        o, c = rows(orig), rows(out)
        if o != c:
            fails.append(f'{name}: values differ ({len(o)} expected rows, {len(c)} in output)')
        sample = next((m for m in out if m.get_type() == name), None)
        if sample and list(sample.get_fieldnames()) != cols:
            fails.append(f'{name}: columns {sample.get_fieldnames()} != {cols}')
        print(f'  {name:5s} {len(c):6d} rows, {len(cols)} cols{" (first instance)" if inst else ""}: ok' if o == c else f'  {name}: MISMATCH')

    def special(name, key, keep):
        o = [(m.TimeUS, getattr(m, key)) for m in orig if m.get_type() == name and getattr(m, key) in keep]
        c = [(m.TimeUS, getattr(m, key)) for m in out if m.get_type() == name]
        if o != c:
            fails.append(f'{name}: expected {len(o)} records, got {len(c)}')
        print(f'  {name:5s} {len(c):6d} records kept: ok' if o == c else f'  {name}: MISMATCH')
    special('PARM', 'Name', params)
    special('MSG', 'Message', texts)

    # leak scan
    kept_strings = params | texts
    secrets = set(secrets_extra)
    for m in orig:
        t = m.get_type()
        if t == 'PARM' and m.Name not in params:
            secrets.add(m.Name)
        elif t == 'MSG' and m.Message not in texts:
            secrets.add(m.Message)
        elif t == 'VER' and 'VER' not in msgs:
            secrets.add(str(m.FWS))
        elif t == 'FILE':
            data = m.Data if isinstance(m.Data, (bytes, bytearray)) else str(m.Data).encode()
            secrets.update(w.decode() for w in re.findall(rb'[A-Za-z0-9_]{6,}', data))
    secrets = {s for s in secrets if len(s) >= 5 and not any(s in k for k in kept_strings)}
    blob = open(out_path, 'rb').read()
    leaked = sorted(s for s in secrets if s.encode() in blob)
    if leaked:
        fails.append(f'leaked strings: {leaked[:10]}')
    print(f'  leak scan: {len(secrets)} removed strings checked, {len(leaked)} found in output')

    if fails:
        print('FAIL')
        for f in fails:
            print('  -', f)
        sys.exit(1)
    print('PASS')


if __name__ == '__main__':
    main()
