"""
Builds a hostile test log from a real one, to exercise the cases SITL logs don't cover:
  - GPS records (instance 0 and a second receiver, instance 1) after every POS
  - BAT records for a second pack (Inst 1)
  - garbage bytes containing secret text between messages
  - a valid-looking header with an undefined message type
  - a corrupt FMT-sized blob carrying secret text in its name/columns

  python test/make_hostile.py real.bin hostile.bin
"""
import struct
import sys

H = b'\xa3\x95'
SIZE = dict(a=64, b=1, B=1, h=2, H=2, i=4, I=4, f=4, d=8, n=4, N=16, Z=64,
            c=2, C=2, e=4, E=4, L=4, M=1, q=8, Q=8)
SECRET = b'SECRET_ATC_RAT_RLL_P=0.135 CubeOrangePlus Here4 T-Motor'


def main(src, dst):
    buf = open(src, 'rb').read()
    lens, names = {128: 89}, {}
    out = bytearray()
    p, n_gps = 0, 0
    while p + 3 <= len(buf):
        if buf[p:p + 2] != H:
            p += 1
            continue
        t = buf[p + 2]
        if t == 128:
            ty, ln = buf[p + 3], buf[p + 4]
            lens[ty] = ln
            names[ty] = buf[p + 5:p + 9].rstrip(b'\0').decode()
        ln = lens.get(t)
        if ln is None or p + ln > len(buf):
            p += 1
            continue
        out += buf[p:p + ln]
        name = names.get(t)
        if name == 'POS':
            tus, lat, lng, alt, rel, relo = struct.unpack('<Qiifff', buf[p + 3:p + ln])
            gid = [k for k, v in names.items() if v == 'GPS'][0]
            for inst in (0, 1):
                body = struct.pack('<QBBIHBhiiiffffB', tus, inst, 6, 123456 + n_gps, 2380, 18, 70,
                                   lat + inst * 50, lng, int(alt * 100) + 150, 5.5 + inst, 90.0, -0.2, 0.0, 1)
                assert len(body) + 3 == lens[gid]
                out += H + bytes([gid]) + body
            n_gps += 1
            if n_gps % 200 == 0:
                out += b'\x00garbage ' + SECRET + b'\x00'
                out += H + bytes([250]) + SECRET   # undefined type id
        if name == 'BAT':
            body = bytearray(buf[p + 3:p + ln])
            body[8] = 1                            # Inst = 1 (second pack)
            out += H + bytes([t]) + bytes(body)
        p += ln
    open(dst, 'wb').write(out)
    print(f'wrote {dst}: {len(out)} bytes, {n_gps * 2} GPS records injected')


if __name__ == '__main__':
    main(*sys.argv[1:3])
