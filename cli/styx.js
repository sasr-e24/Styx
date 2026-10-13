#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Aditya Suresh (sasr-e24)
// Styx command line.
//   node cli/styx.js [--preset ID | --policy FILE.json] [--out DIR] log1.bin [log2.bin ...]
//   node cli/styx.js --list
//   node cli/styx.js --preset ID --dump-policy     (prints the policy as JSON)
//   node cli/styx.js --preset ID --explain log.bin (what the policy keeps from that log, as JSON)
// Default preset: customer. Output: <name>_<preset>.bin next to each input, or in --out DIR.
'use strict';
const fs = require('fs');
const path = require('path');
const { sanitize, scan, ruleFor, compile } = require('../app/engine.js');
const { PRESETS } = require('../app/catalog.js');

const args = process.argv.slice(2);
let presetId = 'customer', policyFile = null, outDir = null, dump = false, explain = false;
const files = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--preset') presetId = args[++i];
  else if (a === '--policy') policyFile = args[++i];
  else if (a === '--out') outDir = args[++i];
  else if (a === '--dump-policy') dump = true;
  else if (a === '--explain') explain = true;
  else if (a === '--list') {
    for (const p of PRESETS) console.log(`${p.id.padEnd(15)} ${p.about}`);
    process.exit(0);
  } else files.push(a);
}

let policy, tag;
if (policyFile) {
  const j = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  policy = j.policy || j;
  tag = (j.id || path.basename(policyFile, '.json')).replace(/[^\w-]+/g, '-');
} else {
  const p = PRESETS.find(x => x.id === presetId);
  if (!p) { console.error(`Unknown preset "${presetId}". Use --list.`); process.exit(1); }
  policy = p.policy;
  tag = p.id;
}
if (dump) { console.log(JSON.stringify(policy, null, 2)); process.exit(0); }
if (explain) {
  // What the policy keeps for one log, as JSON (used by test/verify.py).
  const s = scan(fs.readFileSync(files[0]));
  const cp = compile(policy);
  const messages = {};
  for (const [name, t] of Object.entries(s.types)) {
    const r = ruleFor(name, t.cols, policy);
    if (r) messages[name] = { cols: r.keep.map(i => t.cols[i]), primary: r.primary && !!t.instCol, instCol: t.instCol };
  }
  console.log(JSON.stringify({
    messages,
    params: s.params.map(p => p.name).filter(cp.paramOn),
    texts: s.texts.map(t => t.text).filter(cp.textOn),
  }, null, 1));
  process.exit(0);
}
if (!files.length) {
  console.log('Usage: node cli/styx.js [--preset ID | --policy FILE.json] [--out DIR] log1.bin [...]\n       node cli/styx.js --list');
  process.exit(1);
}

const mb = (b) => (b / 1048576).toFixed(2) + ' MB';
let failed = 0;
for (const file of files) {
  try {
    const { bytes, report: r } = sanitize(fs.readFileSync(file), policy);
    const dest = path.join(outDir || path.dirname(file), path.basename(file).replace(/\.bin$/i, '') + `_${tag}.bin`);
    if (outDir) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(dest, bytes);
    const kept = Object.entries(r.counts).filter(([, c]) => c.kept);
    const removed = Object.entries(r.counts).filter(([, c]) => !c.kept);
    console.log(`\n${file} -> ${dest}`);
    console.log(`  size      ${mb(r.inBytes)} -> ${mb(r.outBytes)}`);
    console.log(`  kept      ${kept.map(([n, c]) => `${n}(${c.kept})`).join(' ')}`);
    console.log(`  removed   ${removed.length} message types, ${removed.reduce((s, [, c]) => s + c.in, 0)} records`);
    if (r.params.length) console.log(`  params    ${r.params.length} kept: ${r.params.slice(0, 12).join(', ')}${r.params.length > 12 ? ', ...' : ''}`);
    if (r.texts.length) console.log(`  text      ${r.texts.length} lines kept`);
    const dc = Object.entries(r.droppedCols).map(([m, c]) => `${m}: ${c.join(',')}`).join('; ');
    if (dc) console.log(`  columns   dropped ${dc}`);
    if (r.skippedBytes) console.log(`  unparsed  ${r.skippedBytes} bytes discarded`);
    if (r.trackSource) {
      console.log(`  flight    ${(r.duration / 60).toFixed(1)} min, max alt ${r.maxAlt.toFixed(1)} m, ` +
        `max speed ${r.maxSpeed.toFixed(1)} m/s (${r.speedSource}), distance ${(r.distance / 1000).toFixed(2)} km`);
    }
  } catch (e) {
    failed++;
    console.error(`\n${file}: FAILED - ${e.stack}`);
  }
}
process.exit(failed ? 1 : 0);
