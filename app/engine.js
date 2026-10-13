// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Aditya Suresh (sasr-e24)
/*
 * Styx engine: reads an ArduPilot DataFlash .bin log and writes a new one that
 * holds only what the policy allows.
 *
 * The output is rebuilt, not filtered in place: new FMT/FMTU records describe only
 * the kept columns and every kept message is re-encoded from those columns. Bytes the
 * parser cannot place in a known message are never copied.
 *
 * Works in the browser (self.StyxEngine, needs catalog.js loaded first) and in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./catalog.js'));
  else root.StyxEngine = factory(root.StyxCatalog);
})(typeof self !== 'undefined' ? self : this, function (catalog) {
  'use strict';

  const { BLOCKED, SPECIAL, TABLES, groupOf } = catalog;
  const H1 = 0xA3, H2 = 0x95, FMT_ID = 128, FMT_LEN = 89;
  const SIZE = { a: 64, b: 1, B: 1, h: 2, H: 2, i: 4, I: 4, f: 4, d: 8, n: 4, N: 16, Z: 64,
                 c: 2, C: 2, e: 4, E: 4, L: 4, M: 1, q: 8, Q: 8 };
  const INST_COLS = ['I', 'Inst', 'Instance'];

  // ---------- low level ----------

  function readStr(buf, off, len) {
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = buf[off + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  function writeStr(out, off, str, len) {
    for (let i = 0; i < len; i++) out[off + i] = i < str.length ? str.charCodeAt(i) & 0xff : 0;
  }

  function readNum(dv, off, ch) {
    switch (ch) {
      case 'b': return dv.getInt8(off);
      case 'B': case 'M': return dv.getUint8(off);
      case 'h': return dv.getInt16(off, true);
      case 'H': return dv.getUint16(off, true);
      case 'i': case 'L': return dv.getInt32(off, true);
      case 'I': return dv.getUint32(off, true);
      case 'f': return dv.getFloat32(off, true);
      case 'd': return dv.getFloat64(off, true);
      case 'c': return dv.getInt16(off, true) * 0.01;
      case 'C': return dv.getUint16(off, true) * 0.01;
      case 'e': return dv.getInt32(off, true) * 0.01;
      case 'E': return dv.getUint32(off, true) * 0.01;
      case 'q': return Number(dv.getBigInt64(off, true));
      case 'Q': return Number(dv.getBigUint64(off, true));
      default: return NaN;
    }
  }

  function toBytes(input) {
    return input instanceof Uint8Array ? input : new Uint8Array(input);
  }

  /*
   * Walks every message. onFmt(type, fmt) is called for each FMT definition,
   * onMsg(fmt, p) for each data message (p = offset of the 0xA3 header byte).
   * Returns the number of bytes that could not be parsed.
   */
  function walk(buf, onFmt, onMsg) {
    const n = buf.length;
    const fmts = new Map();
    let skipped = 0, p = 0;
    // After a run of unparseable bytes, a header-looking pair may be garbage. Until the
    // parser is back in step, a message only counts if another header follows it.
    let synced = true;
    const nextOk = (q) => synced || q + 2 > n || (buf[q] === H1 && buf[q + 1] === H2);
    const skip = () => { p++; skipped++; synced = false; };

    while (p + 3 <= n) {
      if (buf[p] !== H1 || buf[p + 1] !== H2) { skip(); continue; }
      const id = buf[p + 2];
      if (id === FMT_ID) {
        if (p + FMT_LEN > n) break;
        if (!nextOk(p + FMT_LEN)) { skip(); continue; }
        const type = buf[p + 3];
        if (type !== FMT_ID) {
          const f = define(buf[p + 4], readStr(buf, p + 5, 4), readStr(buf, p + 9, 16), readStr(buf, p + 25, 64));
          fmts.set(type, f);
          onFmt(type, f);
        }
        p += FMT_LEN;
        synced = true;
        continue;
      }
      const f = fmts.get(id);
      if (!f) { skip(); continue; }
      if (p + f.len > n) break;
      if (!nextOk(p + f.len)) { skip(); continue; }
      onMsg(f, p, id);
      p += f.len;
      synced = true;
    }
    return skipped + (n - p);
  }

  function define(len, name, format, colStr) {
    const cols = colStr ? colStr.split(',') : [];
    const offs = [];
    let size = 0, ok = cols.length === format.length;
    for (const ch of format) {
      if (!(ch in SIZE)) { ok = false; break; }
      offs.push(size);
      size += SIZE[ch];
    }
    ok = ok && size + 3 === len;
    // Instance column: an integer column named I/Inst/Instance. (PIDx also has a column
    // "I", but it is the integrator, a float.)
    const inst = INST_COLS.map(c => cols.indexOf(c)).find(i => i >= 0 && 'bBhHM'.includes(format[i]));
    return { name, len, format, cols, offs, ok, colStr, inst: inst === undefined ? -1 : inst, group: groupOf(name) };
  }

  function field(dv, f, p, col) {
    const i = typeof col === 'number' ? col : f.cols.indexOf(col);
    if (i < 0) return NaN;
    return readNum(dv, p + 3 + f.offs[i], f.format[i]);
  }

  function fieldStr(buf, f, p, col) {
    const i = f.cols.indexOf(col);
    if (i < 0) return '';
    return readStr(buf, p + 3 + f.offs[i], SIZE[f.format[i]]);
  }

  // ---------- policy ----------

  function globToRe(g) {
    const s = String(g).trim();
    return new RegExp('^' + s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
  }

  function safeRe(s) {
    try { return new RegExp(s, 'i'); } catch (e) { return new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  }

  function compile(policy) {
    const p = policy || {};
    const params = (p.params || []).filter(Boolean).map(globToRe);
    const textRe = (p.text || []).filter(Boolean).map(safeRe);
    const texts = new Set(p.texts || []);
    const textEx = (p.textExclude || []).filter(Boolean).map(safeRe);
    return {
      groups: p.groups || {},
      primary: p.primary !== false,
      messages: p.messages || {},
      paramOn: (name) => params.some(r => r.test(name)),
      textOn: (t) => texts.has(t) || (textRe.some(r => r.test(t)) && !textEx.some(r => r.test(t))),
      anyParams: params.length > 0,
      anyText: textRe.length > 0 || texts.size > 0,
    };
  }

  // What happens to one message type under a policy: null (dropped) or { keep: [col idx], primary }.
  function ruleFor(name, cols, cp) {
    if (BLOCKED.has(name) || SPECIAL.has(name) || TABLES.has(name)) return null;
    let r = cp.messages[name];
    if (r === false) return null;
    if (!r) {
      if (!cp.groups[groupOf(name)]) return null;
      r = { cols: '*', primary: cp.primary };
    }
    const keep = [];
    cols.forEach((c, i) => { if (r.cols === '*' || !r.cols || r.cols.includes(c)) keep.push(i); });
    if (!keep.length) return null;
    return { keep, primary: r.primary !== undefined ? !!r.primary : cp.primary };
  }

  // ---------- scan: what is in the log ----------

  function scan(input) {
    const buf = toBytes(input);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const types = {};        // name -> { cols, format, count, bytes, group, instCol, instances }
    const params = new Map();
    const texts = new Map();
    let tMin = Infinity, tMax = -Infinity;

    const skipped = walk(buf, (type, f) => {
      if (!types[f.name]) {
        types[f.name] = { cols: f.cols, format: f.format, count: 0, bytes: 0, group: f.group,
                          instCol: f.inst >= 0 ? f.cols[f.inst] : null, instances: [] };
      }
    }, (f, p) => {
      const t = types[f.name];
      t.count++;
      t.bytes += f.len;
      if (!f.ok) return;
      if (f.inst >= 0) {
        const v = field(dv, f, p, f.inst);
        if (!t.instances.includes(v)) t.instances.push(v);
      }
      const ts = f.cols[0] === 'TimeUS' ? field(dv, f, p, 0) : NaN;
      if (ts > 0) { if (ts < tMin) tMin = ts; if (ts > tMax) tMax = ts; }
      if (f.name === 'PARM') {
        params.set(fieldStr(buf, f, p, 'Name'), field(dv, f, p, 'Value'));
      } else if (f.name === 'MSG') {
        const s = fieldStr(buf, f, p, 'Message');
        texts.set(s, (texts.get(s) || 0) + 1);
      }
    });

    for (const t of Object.values(types)) t.instances.sort((a, b) => a - b);
    return {
      bytes: buf.length, skipped,
      duration: isFinite(tMax - tMin) ? (tMax - tMin) / 1e6 : 0,
      types,
      params: [...params].map(([name, value]) => ({ name, value })),
      texts: [...texts].map(([text, count]) => ({ text, count })),
    };
  }

  // ---------- sanitize ----------

  /**
   * sanitize(input, policy) -> { bytes: Uint8Array, report }
   */
  function sanitize(input, policy) {
    const buf = toBytes(input);
    const n = buf.length;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const cp = compile(policy);

    const out = new Uint8Array(n + FMT_LEN * 2);
    let o = 0;
    const emitted = new Map();
    const pendingFmtu = new Map();
    const counts = {};
    const plans = new Map();     // fmt object -> plan
    const byType = new Map();    // type id -> fmt
    let tMin = Infinity, tMax = -Infinity;
    const pos = [], gps = [];
    const keptParams = new Set(), keptTexts = new Set();

    function emitFmt(type, len, name, format, cols) {
      const sig = len + '|' + name + '|' + format + '|' + cols;
      if (emitted.get(type) === sig) return;
      emitted.set(type, sig);
      out[o] = H1; out[o + 1] = H2; out[o + 2] = FMT_ID;
      out[o + 3] = type; out[o + 4] = len;
      writeStr(out, o + 5, name, 4);
      writeStr(out, o + 9, format, 16);
      writeStr(out, o + 25, cols, 64);
      o += FMT_LEN;
    }
    emitFmt(FMT_ID, FMT_LEN, 'FMT', 'BBnNZ', 'Type,Length,Name,Format,Columns');

    function writeFmtu(src, fmtuId) {
      const target = byType.get(src[3 + 8]);
      const plan = target && plans.get(target);
      if (!plan) return false;
      let units = readStr(src, 3 + 9, 16), mults = readStr(src, 3 + 25, 16);
      if (plan.kind === 'subset') {
        units = plan.keep.map(i => units[i] || '-').join('');
        mults = plan.keep.map(i => mults[i] || '-').join('');
      }
      out[o] = H1; out[o + 1] = H2; out[o + 2] = fmtuId;
      out.set(src.subarray(3, 3 + 9), o + 3);
      writeStr(out, o + 3 + 9, units, 16);
      writeStr(out, o + 3 + 25, mults, 16);
      o += 3 + 41;
      return true;
    }

    const skipped = walk(buf, (type, f) => {
      byType.set(type, f);
      let plan = null;
      if (f.ok) {
        if (f.name === 'FMTU' && f.format === 'QBNN') plan = { kind: 'fmtu' };
        else if (f.name === 'UNIT' || f.name === 'MULT') plan = { kind: 'whole' };
        else if (f.name === 'PARM' && cp.anyParams && f.cols.includes('Name')) plan = { kind: 'param' };
        else if (f.name === 'MSG' && cp.anyText && f.cols.includes('Message')) plan = { kind: 'text' };
        else {
          const r = ruleFor(f.name, f.cols, cp);
          if (r) {
            plan = {
              kind: 'subset', keep: r.keep,
              primary: r.primary && f.inst >= 0,
              newLen: 3 + r.keep.reduce((s, i) => s + SIZE[f.format[i]], 0),
              dropped: f.cols.filter((c, i) => !r.keep.includes(i)),
            };
          }
        }
      }
      if (plan) {
        plans.set(f, plan);
        if (plan.kind === 'subset') {
          emitFmt(type, plan.newLen, f.name, plan.keep.map(i => f.format[i]).join(''), plan.keep.map(i => f.cols[i]).join(','));
        } else {
          emitFmt(type, f.len, f.name, f.format, f.colStr);
        }
      } else {
        plans.delete(f);
      }
      const waiting = pendingFmtu.get(type);
      if (waiting) {
        pendingFmtu.delete(type);
        for (const m of waiting) writeFmtu(m.bytes, m.id);
      }
    }, (f, p, id) => {
      const plan = plans.get(f);
      let kept = false;
      if (plan) {
        switch (plan.kind) {
          case 'whole':
            out.set(buf.subarray(p, p + f.len), o); o += f.len; kept = true;
            break;
          case 'param': {
            const name = fieldStr(buf, f, p, 'Name');
            if (cp.paramOn(name)) { out.set(buf.subarray(p, p + f.len), o); o += f.len; kept = true; keptParams.add(name); }
            break;
          }
          case 'text': {
            const t = fieldStr(buf, f, p, 'Message');
            if (cp.textOn(t)) { out.set(buf.subarray(p, p + f.len), o); o += f.len; kept = true; keptTexts.add(t); }
            break;
          }
          case 'fmtu': {
            const target = buf[p + 3 + 8];
            if (!byType.has(target)) {
              const list = pendingFmtu.get(target) || [];
              list.push({ bytes: buf.slice(p, p + f.len), id });
              pendingFmtu.set(target, list);
            } else {
              kept = writeFmtu(buf.subarray(p, p + f.len), id);
            }
            break;
          }
          case 'subset': {
            if (plan.primary && field(dv, f, p, f.inst) !== 0) break;
            const base = p + 3;
            out[o] = H1; out[o + 1] = H2; out[o + 2] = id;
            let w = o + 3;
            for (const i of plan.keep) {
              const sz = SIZE[f.format[i]];
              out.set(buf.subarray(base + f.offs[i], base + f.offs[i] + sz), w);
              w += sz;
            }
            o += plan.newLen;
            kept = true;
            if (f.cols[0] === 'TimeUS') {
              const t = field(dv, f, p, 0);
              if (t > 0) { if (t < tMin) tMin = t; if (t > tMax) tMax = t; }
            }
            if (f.name === 'POS') {
              pos.push({ t: field(dv, f, p, 'TimeUS') / 1e6, lat: field(dv, f, p, 'Lat') * 1e-7,
                         lng: field(dv, f, p, 'Lng') * 1e-7, alt: field(dv, f, p, 'RelHomeAlt') });
            } else if (f.name === 'GPS' && (f.inst < 0 || field(dv, f, p, f.inst) === 0)) {
              gps.push({ t: field(dv, f, p, 'TimeUS') / 1e6, lat: field(dv, f, p, 'Lat') * 1e-7,
                         lng: field(dv, f, p, 'Lng') * 1e-7, alt: field(dv, f, p, 'Alt'),
                         spd: field(dv, f, p, 'Spd'), status: field(dv, f, p, 'Status') });
            }
            break;
          }
        }
      }
      const c = counts[f.name] || (counts[f.name] = { in: 0, kept: 0, group: f.group });
      c.in++;
      if (kept) c.kept++;
    });

    const dropped = {};
    for (const [f, plan] of plans) {
      if (plan.kind === 'subset' && plan.dropped.length && counts[f.name] && counts[f.name].kept) dropped[f.name] = plan.dropped;
    }

    return {
      bytes: out.slice(0, o),
      report: Object.assign({
        inBytes: n, outBytes: o, skippedBytes: skipped, counts, droppedCols: dropped,
        params: [...keptParams], texts: [...keptTexts],
        duration: isFinite(tMax - tMin) ? (tMax - tMin) / 1e6 : 0,
      }, flightSummary(pos, gps)),
    };
  }

  function haversine(lat1, lng1, lat2, lng2) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // Track, distance, max altitude/speed from the kept POS (or GPS) data.
  function flightSummary(pos, gps) {
    let src = 'POS';
    let pts = pos.filter(s => s.lat || s.lng);
    if (!pts.length) {
      src = 'GPS';
      pts = gps.filter(s => s.status >= 3 && (s.lat || s.lng));
      if (pts.length) { const a0 = pts[0].alt; pts = pts.map(s => Object.assign({}, s, { alt: s.alt - a0 })); }
    }
    if (!pts.length) return { trackSource: null, track: [], maxAlt: null, maxSpeed: null, speedSource: null, distance: null };

    let dist = 0, maxDerived = 0, last = null;
    for (const s of pts) {
      if (!last) { last = s; continue; }
      const dt = s.t - last.t;
      if (dt < 1) continue;
      const d = haversine(last.lat, last.lng, s.lat, s.lng);
      dist += d;
      if (dt < 5) maxDerived = Math.max(maxDerived, d / dt);
      last = s;
    }
    const gpsSpd = gps.filter(s => s.status >= 3 && isFinite(s.spd));
    const maxSpeed = gpsSpd.length ? gpsSpd.reduce((m, s) => (s.spd > m ? s.spd : m), 0) : maxDerived;
    const step = Math.max(1, Math.ceil(pts.length / 1500));
    return {
      trackSource: src,
      track: pts.filter((_, i) => i % step === 0).map(s => ({ t: s.t, lat: s.lat, lng: s.lng, alt: s.alt })),
      maxAlt: pts.reduce((m, s) => (isFinite(s.alt) && s.alt > m ? s.alt : m), -Infinity),
      maxSpeed, speedSource: gpsSpd.length ? 'GPS' : 'track',
      distance: dist,
    };
  }

  return { scan, sanitize, ruleFor: (name, cols, policy) => ruleFor(name, cols, compile(policy)), compile, catalog };
});
