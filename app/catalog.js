/*
 * Styx catalog: which ArduPilot log messages belong to which data group, and the
 * built-in presets. Edit this file to add messages or team presets.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StyxCatalog = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Order here is the order shown in the app.
  // match: exact names and/or regex. reveals: what sharing this group gives away.
  const GROUPS = [
    { id: 'position', label: 'Position and altitude',
      about: 'Estimated position, height above home, home/origin, Smart RTL path.',
      reveals: null,
      names: ['POS', 'ORGN', 'SRTL'] },
    { id: 'gps', label: 'GPS',
      about: 'Fix, satellites, speed, accuracy, GPS yaw, raw receiver data.',
      reveals: 'Accuracy and raw columns can identify the receiver. Extra instances show a dual/moving-baseline setup.',
      names: ['GPS', 'GPA', 'GPS2', 'GPA2', 'GPSB', 'GPAB', 'GRAW', 'GRXH', 'GRXS', 'GPYW'],
      re: /^(UBX\d|SBF|SBR)/ },
    { id: 'flight', label: 'Flight events',
      about: 'Flight modes, arm/disarm, events such as takeoff and land.',
      reveals: null,
      names: ['MODE', 'EV', 'ARM', 'STAT', 'LAND'] },
    { id: 'mission', label: 'Mission',
      about: 'Mission items, rally points, fence.',
      reveals: null,
      names: ['CMD', 'RALY', 'FNCE', 'FENC'] },
    { id: 'attitude', label: 'Attitude',
      about: 'Roll, pitch, yaw, and the controller setpoints for each.',
      reveals: 'Setpoint columns (DesRoll etc.) show how well the aircraft is tuned.',
      names: ['ATT'] },
    { id: 'power', label: 'Battery',
      about: 'Pack voltage, current, consumed capacity, cell voltages.',
      reveals: 'Voltage and cells give pack configuration; current gives power draw.',
      names: ['BAT', 'BCL', 'CURR', 'BAT2'] },
    { id: 'control', label: 'Controller and tuning',
      about: 'PID loops, position/velocity controllers, TECS, autotune.',
      reveals: 'Tuning gains in effect and control performance.',
      names: ['RATE', 'CTUN', 'NTUN', 'QTUN', 'TECS', 'TEC2', 'ANG', 'ATUN', 'ATDE', 'ATRP', 'AETR',
              'GUIP', 'GUIA', 'CTRL', 'TSIT', 'WVNE', 'LOIT', 'DFLT', 'LDET', 'TRAN', 'SURF'],
      re: /^(PID|PSC|PSO)/ },
    { id: 'propulsion', label: 'Motors and ESCs',
      about: 'Motor outputs, ESC telemetry, RPM, engine data.',
      reveals: 'Thrust margin, ESC model and motor health.',
      names: ['MOTB', 'RPM', 'EFI', 'EFI2', 'ECYL', 'ICE', 'GEN', 'HELI', 'EDT2'],
      re: /^(RCO|ESC)/ },
    { id: 'rc', label: 'RC input',
      about: 'Pilot stick inputs and link quality.',
      reveals: 'RC system and pilot inputs.',
      names: ['RSSI'],
      re: /^RCI/ },
    { id: 'imu', label: 'IMU and vibration',
      about: 'Accelerometers, gyros, vibration levels, FFT and notch data.',
      reveals: 'Frame vibration and IMU performance.',
      names: ['IMU', 'VIBE', 'IMT'],
      re: /^(IMU|ACC|GYR|ISB|FTN|VIB)/ },
    { id: 'sensors', label: 'Other sensors',
      about: 'Baro, compass, airspeed, rangefinder, optical flow, vision, terrain.',
      reveals: 'Which sensors are fitted and how they perform.',
      names: ['RFND', 'PRX', 'PRXR', 'OF', 'BCN', 'TERR', 'WIND', 'HYGR', 'TEMP', 'AOA', 'ARSP'],
      re: /^(BAR|MAG|VIS|ASP|PRX)/ },
    { id: 'estimator', label: 'EKF and estimator',
      about: 'EKF states, innovations, health, secondary attitude estimate.',
      reveals: 'Navigation filter tuning and sensor health.',
      names: ['AHR2', 'DCM', 'EAHR', 'RAD'],
      re: /^(XK|NK)/ },
    { id: 'system', label: 'System and identity',
      about: 'Firmware version and board, CPU load, serial ports, MAVLink, errors, simulator.',
      reveals: 'Board type, firmware build, failures, internal configuration.',
      names: ['VER', 'PM', 'UART', 'MAV', 'MAVC', 'DSF', 'DU32', 'D32', 'DSTL', 'ERR', 'MCU', 'POWR',
              'RTC', 'SIM', 'SIM2', 'SITL', 'LOG', 'SCR', 'PRTN', 'MON', 'CAND'] },
  ];

  // Never written to the output, whatever the policy says.
  const BLOCKED = new Set(['FILE']);
  // Handled by their own filters (parameter names, text lines), not by groups.
  const SPECIAL = new Set(['PARM', 'MSG']);
  // Format tables. UNIT/MULT are generic; FMTU is rewritten to match kept columns.
  const TABLES = new Set(['FMT', 'FMTU', 'UNIT', 'MULT']);

  const byName = new Map();
  for (const g of GROUPS) for (const n of g.names) byName.set(n, g.id);

  function groupOf(name) {
    if (byName.has(name)) return byName.get(name);
    for (const g of GROUPS) if (g.re && g.re.test(name)) return g.id;
    return 'other';
  }

  const TRACK_GPS = ['TimeUS', 'I', 'Status', 'GMS', 'GWk', 'NSats', 'HDop', 'Lat', 'Lng', 'Alt', 'Spd', 'GCrs', 'VZ'];
  const ARM_STATE = ['TimeUS', 'ArmState'];
  const ATT_ACTUAL = ['TimeUS', 'Roll', 'Pitch', 'Yaw'];
  const BAT_BASIC = ['TimeUS', 'Inst', 'Volt', 'Curr', 'CurrTot', 'RemPct'];

  /*
   * Preset = policy:
   *   groups:   { groupId: true }  whole group, all columns
   *   primary:  true = keep only instance 0 of group messages (hides second GPS, extra packs, ...)
   *   messages: { NAME: { cols: '*' | [..], primary: bool } | false }  per-message override
   *   params:   ['GPS*', 'EK3_SRC1_YAW']  parameter name globs ('*' = any characters)
   *   text:     ['^GPS']  regexes (case-insensitive) for text messages to keep
   */
  const PRESETS = [
    { id: 'customer', label: 'Customer',
      about: 'Track, altitude, speed, modes and mission. Nothing about the aircraft.',
      policy: {
        groups: {}, primary: true,
        messages: {
          GPS: { cols: TRACK_GPS, primary: true }, POS: { cols: '*' }, ORGN: { cols: '*' },
          MODE: { cols: '*' }, EV: { cols: '*' }, ARM: { cols: ARM_STATE }, CMD: { cols: '*' },
        },
        params: [], text: [],
      } },
    { id: 'customer-plus', label: 'Customer, detailed',
      about: 'Customer, plus actual attitude and basic battery figures.',
      policy: {
        groups: {}, primary: true,
        messages: {
          GPS: { cols: TRACK_GPS, primary: true }, POS: { cols: '*' }, ORGN: { cols: '*' },
          MODE: { cols: '*' }, EV: { cols: '*' }, ARM: { cols: ARM_STATE }, CMD: { cols: '*' },
          ATT: { cols: ATT_ACTUAL }, BAT: { cols: BAT_BASIC, primary: true },
        },
        params: [], text: [],
      } },
    { id: 'gps-vendor', label: 'GPS vendor',
      about: 'All GPS data from every receiver, position, heading, GPS parameters and GPS text messages.',
      policy: {
        groups: { gps: true }, primary: false,
        messages: {
          POS: { cols: '*' }, ORGN: { cols: '*' }, MODE: { cols: '*' }, EV: { cols: '*' },
          ARM: { cols: ARM_STATE }, ATT: { cols: ATT_ACTUAL },
        },
        params: ['GPS*', 'EK3_SRC*'],
        text: ['gps', 'u-?blox', 'rtk', 'septentrio', 'unicore', 'nmea', 'trimble', 'novatel', 'moving ?base',
               '^Ardu[A-Za-z]* V\\d'],
      } },
    { id: 'partner', label: 'Trusted partner',
      about: 'All flight data. Parameters, text messages, firmware and board identity are still removed.',
      policy: {
        groups: { position: true, gps: true, flight: true, mission: true, attitude: true, power: true,
                  control: true, propulsion: true, rc: true, imu: true, sensors: true, estimator: true },
        primary: false, messages: {}, params: [], text: [],
      } },
  ];

  return { GROUPS, PRESETS, BLOCKED, SPECIAL, TABLES, groupOf };
});
