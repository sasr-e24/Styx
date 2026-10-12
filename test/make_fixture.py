"""
Writes a synthetic ArduPilot DataFlash log for tests, so CI does not need real logs.

  python test/make_fixture.py out.bin

Contents: a 2-minute circle at 30 m, two GPS receivers (moving-baseline style), GPA,
two battery packs, two IMUs, VIBE, RCOU, PIDR, XKF1, ATT, POS, ORGN, MODE, EV, ARM, CMD,
ERR, VER, PARM (incl. GPS and tuning params), MSG (incl. GPS and board lines), FILE,
FMTU/UNIT/MULT, plus some junk bytes between messages.
"""
import math
import struct
import sys

H = b'\xa3\x95'
SIZE = dict(a=64, b=1, B=1, h=2, H=2, i=4, I=4, f=4, d=8, n=4, N=16, Z=64,
            c=2, C=2, e=4, E=4, L=4, M=1, q=8, Q=8)
PACK = dict(b='b', B='B', h='h', H='H', i='i', I='I', f='f', d='d', n='4s', N='16s', Z='64s',
            c='h', C='H', e='i', E='I', L='i', M='B', q='q', Q='Q')

# name, format, columns, units, mults (units/mults only for some, to exercise FMTU)
DEFS = [
    ('UNIT', 'QbZ', 'TimeUS,Id,Label', None, None),
    ('MULT', 'Qbd', 'TimeUS,Id,Mult', None, None),
    ('FMTU', 'QBNN', 'TimeUS,FmtType,UnitIds,MultIds', None, None),
    ('PARM', 'QNff', 'TimeUS,Name,Value,Default', None, None),
    ('MSG', 'QZ', 'TimeUS,Message', None, None),
    ('VER', 'QBHBBBBIZ', 'TimeUS,BT,BST,Maj,Min,Pat,FWT,GH,FWS', None, None),
    ('FILE', 'NIBZ', 'FileName,Offset,Length,Data', None, None),
    ('GPS', 'QBBIHBcLLeffffB', 'TimeUS,I,Status,GMS,GWk,NSats,HDop,Lat,Lng,Alt,Spd,GCrs,VZ,Yaw,U',
     's#-s-S-DUmnhnh-', 'F--C--BGGB000--'),
    ('GPA', 'QBCCCCfBIHf', 'TimeUS,I,VDop,HAcc,VAcc,SAcc,YAcc,VV,SMS,Delta,Und', None, None),
    ('POS', 'QLLfff', 'TimeUS,Lat,Lng,Alt,RelHomeAlt,RelOriginAlt', 'sDUmmm', 'FGG000'),
    ('ORGN', 'QBLLe', 'TimeUS,Type,Lat,Lng,Alt', None, None),
    ('ATT', 'QffffffB', 'TimeUS,DesRoll,Roll,DesPitch,Pitch,DesYaw,Yaw,AEKF', 'sddddhh-', 'F000000-'),
    ('BAT', 'QBfffffcfBBB', 'TimeUS,Inst,Volt,VoltR,Curr,CurrTot,EnrgTot,Temp,Res,RemPct,H,SH', None, None),
    ('IMU', 'QBffffffIIfBBHH', 'TimeUS,I,GyrX,GyrY,GyrZ,AccX,AccY,AccZ,EG,EA,T,GH,AH,GHz,AHz', None, None),
    ('VIBE', 'QBfffI', 'TimeUS,IMU,VibeX,VibeY,VibeZ,Clip', None, None),
    ('RCOU', 'QHHHHHHHHHHHHHH', 'TimeUS,C1,C2,C3,C4,C5,C6,C7,C8,C9,C10,C11,C12,C13,C14', None, None),
    ('PIDR', 'QffffffffB', 'TimeUS,Tar,Act,Err,P,I,D,FF,Dmod,Flags', None, None),
    ('XKF1', 'QBccCfffffffccce', 'TimeUS,C,Roll,Pitch,Yaw,VN,VE,VD,dPD,PN,PE,PD,GX,GY,GZ,OH', None, None),
    ('MODE', 'QMBB', 'TimeUS,Mode,ModeNum,Rsn', None, None),
    ('EV', 'QB', 'TimeUS,Id', None, None),
    ('ARM', 'QBIBB', 'TimeUS,ArmState,ArmChecks,Forced,Method', None, None),
    ('CMD', 'QHHHffffLLfB', 'TimeUS,CTot,CNum,CId,Prm1,Prm2,Prm3,Prm4,Lat,Lng,Alt,Frame', None, None),
    ('ERR', 'QBB', 'TimeUS,Subsys,ECode', None, None),
]

PARAMS = [('ATC_RAT_RLL_P', 0.135), ('ATC_RAT_PIT_P', 0.142), ('INS_HNTCH_FREQ', 82.0),
          ('MOT_THST_HOVER', 0.31), ('SERIAL3_PROTOCOL', 5), ('GPS_TYPE', 17), ('GPS_TYPE2', 18),
          ('GPS_AUTO_CONFIG', 1), ('GPS_POS1_X', 0.21), ('GPS_POS2_X', -0.21), ('GPS1_RATE_MS', 200),
          ('EK3_SRC1_YAW', 2), ('EK3_SRC1_POSXY', 3), ('BATT_CAPACITY', 22000), ('FRAME_CLASS', 1)]
TEXTS = ['ArduCopter V4.6.3 (3fc7011a)', 'CubeOrangePlus 0034001B3132510F33383538',
         'ChibiOS: 6a85082c', 'Frame: QUAD/X', 'GPS 1: detected u-blox at 230400 baud',
         'GPS 2: detected u-blox at 230400 baud', 'u-blox 1 HW: 00190000 SW: EXT CORE 1.00 (61b2dd)',
         'IMU0: fast sampling enabled 8.0kHz', 'RCOut: PWM:1-12', 'GPS 1: specified as UBLOX',
         'EKF3 IMU0 is using GPS', 'Arming motors', 'Disarming motors']


def main(path):
    ids = {}
    out = bytearray()

    def fmt(type_id, name, f, cols):
        ln = 3 + sum(SIZE[c] for c in f)
        out.extend(H + bytes([128]) + struct.pack('<BB4s16s64s', type_id, ln, name.encode(), f.encode(), cols.encode()))

    def msg(name, *vals):
        type_id, f = ids[name]
        packed = [v.encode() if isinstance(v, str) else v for v in vals]
        out.extend(H + bytes([type_id]) + struct.pack('<' + ''.join(PACK[c] for c in f), *packed))

    fmt(128, 'FMT', 'BBnNZ', 'Type,Length,Name,Format,Columns')
    for i, (name, f, cols, _, _) in enumerate(DEFS):
        ids[name] = (60 + i, f)
        fmt(60 + i, name, f, cols)
    for uid, label in [('s', 'seconds'), ('m', 'm'), ('D', 'deglatitude'), ('U', 'deglongitude'),
                       ('d', 'deg'), ('n', 'm/s'), ('h', 'degheading'), ('S', 'satellites'), ('#', 'instance'), ('-', '')]:
        msg('UNIT', 0, ord(uid), label)
    for mid, m in [('F', 1e-6), ('G', 1e-7), ('B', 1e-2), ('C', 1e-3), ('0', 1.0), ('-', 0.0)]:
        msg('MULT', 0, ord(mid), m)
    for name, f, cols, units, mults in DEFS:
        if units:
            msg('FMTU', 0, ids[name][0], units, mults)

    t = 1_000_000
    msg('VER', t, 140, 0, 4, 6, 3, 1, 0x3fc7011a, 'ArduCopter V4.6.3 (3fc7011a)')
    for k, (pname, v) in enumerate(PARAMS):
        msg('PARM', t + k, pname, v, v)
    for k, s in enumerate(TEXTS[:-2]):
        msg('MSG', t + k, s)
    for k in range(3):
        msg('FILE', '@PARAM/defaults', k * 64, 64, f'ATC_RAT_YAW_P 0.18 SECRET_DEFAULTS_{k}')

    lat0, lng0 = 12.9716, 77.5946
    msg('ORGN', t, 0, int(lat0 * 1e7), int(lng0 * 1e7), 91000)
    msg('CMD', t, 3, 0, 16, 0, 0, 0, 0, int(lat0 * 1e7), int(lng0 * 1e7), 30.0, 3)
    msg('MODE', t, 4, 4, 1)
    msg('ARM', t + 5, 1, 0x7fffffff, 0, 1)
    msg('MSG', t + 5, 'Arming motors')
    msg('EV', t + 5, 10)

    gms0 = 300_000_000
    for k in range(1200):                     # 120 s at 10 Hz
        tt = t + 1_000_000 + k * 100_000
        ang = 2 * math.pi * k / 600
        alt = min(30.0, k * 0.3) if k < 1100 else max(0.0, 30.0 - (k - 1100) * 0.3)
        lat = lat0 + (100 * math.sin(ang)) / 111320
        lng = lng0 + (100 * (1 - math.cos(ang))) / (111320 * math.cos(math.radians(lat0)))
        msg('POS', tt, int(lat * 1e7), int(lng * 1e7), 910 + alt, alt, alt)
        msg('ATT', tt, 1.0, 1.2, -0.5, -0.4, 90, 91, 3)
        for inst in (0, 1):
            msg('GPS', tt, inst, 6, gms0 + k * 100, 2380, 22, 60, int(lat * 1e7) + inst * 20, int(lng * 1e7),
                int((910 + alt) * 100), 10.47, 90.0, -0.1, 91.5 if inst == 0 else 0.0, 1)
            msg('GPA', tt, inst, 120, 2, 3, 15, 30, 1, gms0 + k * 100, 200, 0.0)
            msg('BAT', tt, inst, 48.1, 49.0, 42.0, k * 1.2, k * 50.0, 3200, 0.004, 90 - k // 20, 1, 0)
            msg('IMU', tt, inst, 0.01, 0.02, 0.0, 0.1, 0.0, -9.8, 0, 0, 45.0, 1, 1, 1000, 1000)
        msg('VIBE', tt, 0, 12.0, 14.0, 20.0, 0)
        msg('RCOU', tt, *([1550] * 4 + [1000] * 10))
        msg('PIDR', tt, 1.0, 0.9, 0.1, 0.05, 0.01, 0.002, 0.0, 1.0, 0)
        msg('XKF1', tt, 0, 120, -40, 9000, 10.4, 0.1, -0.1, 0.0, 1.0, 2.0, -alt, 1, 1, 1, 0)
        if k == 600:
            msg('ERR', tt, 6, 1)
            msg('MSG', tt, 'GPS 2: u-blox RTK fixed')
            out.extend(b'\x00junk CubeOrangePlus SECRET_JUNK\x00')
    tt = t + 1_000_000 + 1200 * 100_000
    msg('ARM', tt, 0, 0, 0, 1)
    msg('MSG', tt, 'Disarming motors')
    msg('EV', tt, 11)
    out.extend(H + bytes([ids['POS'][0]]) + b'\x00' * 10)   # truncated tail
    open(path, 'wb').write(out)
    print(f'wrote {path}: {len(out)} bytes')


if __name__ == '__main__':
    main(sys.argv[1])
