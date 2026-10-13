// Preset and policy behaviour on the synthetic fixture.
//   python3 test/make_fixture.py test/fixture.bin && node --test test/engine.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { scan, sanitize } = require('../app/engine.js');
const { PRESETS } = require('../app/catalog.js');

const FIX = process.env.STYX_FIXTURE || path.join(__dirname, 'fixture.bin');
const buf = fs.readFileSync(FIX);
const preset = (id) => PRESETS.find(p => p.id === id).policy;
const run = (policy) => sanitize(buf, policy);
const kept = (r) => Object.entries(r.report.counts).filter(([, c]) => c.kept).map(([n]) => n).sort();
const has = (bytes, s) => Buffer.from(bytes).includes(Buffer.from(s));
const TABLES = ['FMTU', 'MULT', 'UNIT'];

test('scan sees everything in the fixture', () => {
  const s = scan(buf);
  for (const n of ['GPS', 'GPA', 'PARM', 'MSG', 'FILE', 'IMU', 'VER']) assert.ok(s.types[n], n);
  assert.deepStrictEqual(s.types.GPS.instances, [0, 1]);
  assert.strictEqual(s.params.length, 15);
  assert.strictEqual(s.types.PIDR.instCol, null);
  assert.ok(s.texts.some(t => t.text === 'GPS 2: u-blox RTK fixed'));
});

test('customer: track only, first GPS, no text or params', () => {
  const r = run(preset('customer'));
  assert.deepStrictEqual(kept(r), ['ARM', 'CMD', 'EV', 'GPS', 'MODE', 'ORGN', 'POS', ...TABLES].sort());
  assert.strictEqual(r.report.counts.GPS.kept, 1200);
  assert.deepStrictEqual(r.report.droppedCols.GPS, ['Yaw', 'U']);
  for (const s of ['CubeOrangePlus', 'ArduCopter', 'GPS_TYPE', 'SECRET', 'u-blox', 'ATC_RAT']) assert.ok(!has(r.bytes, s), s);
  assert.ok(Math.abs(r.report.maxAlt - 30) < 0.01);
  assert.ok(r.report.distance > 1100 && r.report.distance < 1300);
});

test('gps vendor: both receivers, GPS params and GPS text only', () => {
  const r = run(preset('gps-vendor'));
  assert.strictEqual(r.report.counts.GPS.kept, 2400);
  assert.strictEqual(r.report.counts.GPA.kept, 2400);
  assert.deepStrictEqual(r.report.params.sort(),
    ['EK3_SRC1_POSXY', 'EK3_SRC1_YAW', 'GPS1_RATE_MS', 'GPS_AUTO_CONFIG', 'GPS_POS1_X', 'GPS_POS2_X', 'GPS_TYPE', 'GPS_TYPE2']);
  assert.ok(r.report.texts.includes('ArduCopter V4.6.3 (3fc7011a)'));
  assert.ok(r.report.texts.includes('GPS 2: u-blox RTK fixed'));
  for (const s of ['CubeOrangePlus', 'ChibiOS', 'QUAD/X', 'IMU0: fast', 'ATC_RAT', 'SERIAL3', 'SECRET']) assert.ok(!has(r.bytes, s), s);
  for (const n of ['IMU', 'VIBE', 'RCOU', 'PIDR', 'XKF1', 'VER', 'FILE', 'CMD', 'FGS']) assert.ok(!r.report.counts[n].kept, n);
});

test('gps vendor: board power, battery, CAN stats and errors for diagnosis', () => {
  const r = run(preset('gps-vendor'));
  for (const n of ['POWR', 'MCU', 'BAT', 'CANS', 'ERR']) assert.ok(r.report.counts[n].kept, n);
  assert.strictEqual(r.report.counts.CANS.kept, 240);           // both CAN interfaces
  assert.ok(!r.report.texts.some(t => /QuikTune|Autotune/.test(t)));
});

test('everything but parameters', () => {
  const r = run(preset('no-params'));
  for (const n of ['IMU', 'PIDR', 'VER', 'ERR', 'POWR', 'FGS', 'GPS', 'XKF1']) assert.ok(r.report.counts[n].kept, n);
  assert.strictEqual(r.report.counts.GPS.kept, 2400);
  assert.ok(!r.report.counts.PARM.kept && !r.report.counts.FILE.kept);
  assert.ok(r.report.texts.includes('CubeOrangePlus 0034001B3132510F33383538'));
  assert.ok(!r.report.texts.some(t => /QuikTune|Autotune/.test(t)), 'tuning text dropped');
  for (const s of ['ATC_RAT_RLL_P', 'ATC_RAT_PIT_P', 'INS_HNTCH', 'GPS_TYPE', 'SECRET']) assert.ok(!has(r.bytes, s), s);
});

test('PID "I" column is the integrator, not an instance', () => {
  const r = run({ groups: { control: true }, primary: true });
  assert.strictEqual(r.report.counts.PIDR.kept, 1200);
});

test('trusted partner: all flight data, still no identity', () => {
  const r = run(preset('partner'));
  for (const n of ['IMU', 'VIBE', 'RCOU', 'PIDR', 'XKF1', 'BAT', 'GPA']) assert.ok(r.report.counts[n].kept, n);
  for (const n of ['PARM', 'MSG', 'VER', 'FILE', 'ERR', 'CANS', 'FGS']) assert.ok(!r.report.counts[n].kept, n);
  assert.ok(r.report.counts.POWR.kept);
  for (const s of ['CubeOrangePlus', 'ArduCopter', 'SECRET', 'ATC_RAT']) assert.ok(!has(r.bytes, s), s);
});

test('FILE can never be kept', () => {
  const r = run({ messages: { FILE: { cols: '*' } }, groups: { other: true, system: true } });
  assert.ok(!r.report.counts.FILE.kept);
  assert.ok(!has(r.bytes, 'SECRET_DEFAULTS'));
});

test('per-message override beats group, columns subset works', () => {
  const r = run({ groups: { imu: true }, primary: true, messages: { VIBE: false, IMU: { cols: ['TimeUS', 'I', 'AccZ'], primary: false } } });
  assert.strictEqual(r.report.counts.IMU.kept, 2400);
  assert.ok(!r.report.counts.VIBE.kept);
  assert.ok(r.report.droppedCols.IMU.includes('GyrX'));
});

test('exact parameter names and exact text lines', () => {
  const r = run({ params: ['FRAME_CLASS'], texts: ['Frame: QUAD/X'] });
  assert.deepStrictEqual(r.report.params, ['FRAME_CLASS']);
  assert.deepStrictEqual(r.report.texts, ['Frame: QUAD/X']);
  assert.ok(!has(r.bytes, 'CubeOrangePlus'));
});

test('empty policy keeps only format tables', () => {
  const r = run({});
  assert.deepStrictEqual(kept(r), ['MULT', 'UNIT']);
  assert.ok(r.bytes.length < 3000);
});

test('garbage between messages is dropped, neighbours are kept', () => {
  const s = scan(buf);
  assert.strictEqual(s.types.MSG.count, 16);
  assert.ok(s.skipped > 0);
});
