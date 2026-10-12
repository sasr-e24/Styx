(function () {
  'use strict';
  const C = window.StyxCatalog, E = window.StyxEngine;
  const { GROUPS, PRESETS, BLOCKED, SPECIAL, TABLES, groupOf } = C;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const fmtBytes = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? (b / 1024).toFixed(0) + ' KB' : b + ' B';
  const fmtDur = (s) => { const t = Math.round(s), m = Math.floor(t / 60); return m + ':' + String(t % 60).padStart(2, '0'); };
  const plural = (n, a, b) => n + ' ' + (n === 1 ? a : b);
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'custom';
  const isData = (n) => !BLOCKED.has(n) && !SPECIAL.has(n) && !TABLES.has(n);

  // ---------- browser storage (per viewer, may be unavailable) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
  };

  // ---------- engine backend: worker when served over http(s), else in-page ----------
  const backend = (() => {
    const local = new Map();
    const waiting = new Map();
    let worker = null, seq = 0;
    function runLocal(msg) {
      return new Promise((resolve, reject) => setTimeout(() => {
        try {
          if (msg.cmd === 'load') { local.set(msg.id, new Uint8Array(msg.buf)); resolve({ scan: E.scan(local.get(msg.id)) }); }
          else if (msg.cmd === 'run') { const r = E.sanitize(local.get(msg.id), msg.policy); resolve({ report: r.report, bytes: r.bytes }); }
          else { local.delete(msg.id); resolve({}); }
        } catch (err) { reject(err); }
      }, 0));
    }
    try {
      if (location.protocol !== 'file:' && window.Worker) {
        worker = new Worker('worker.js');
        worker.onmessage = (e) => {
          const w = waiting.get(e.data.seq);
          if (!w) return;
          waiting.delete(e.data.seq);
          if (e.data.error) w.reject(new Error(e.data.error)); else w.resolve(e.data);
        };
        worker.onerror = () => {      // worker failed to start: finish pending work in-page
          worker = null;
          for (const [s, w] of waiting) { waiting.delete(s); runLocal(w.msg).then(w.resolve, w.reject); }
        };
      }
    } catch (e) { worker = null; }
    function call(msg) {
      if (!worker) return runLocal(msg);
      return new Promise((resolve, reject) => {
        const s = ++seq;
        waiting.set(s, { resolve, reject, msg });
        worker.postMessage(Object.assign({ seq: s }, msg));
      });
    }
    return {
      load: (id, buf) => call({ cmd: 'load', id, buf }),
      run: (id, policy) => call({ cmd: 'run', id, policy }),
      drop: (id) => call({ cmd: 'drop', id }),
    };
  })();

  // ---------- state ----------
  const last = store.get('styx.last', null);
  const S = {
    files: [],
    custom: store.get('styx.presets', []),
    presetId: 'customer',
    policy: clone(PRESETS[0].policy),
    modified: false,
    open: new Set(),
    paramQuery: '',
    U: { types: {}, params: new Map(), texts: new Map() },
  };
  if (last && last.policy) { S.presetId = last.presetId; S.policy = last.policy; S.modified = !!last.modified; }
  let nextId = 1, runGen = 0, runTimer = null;

  const presets = () => PRESETS.concat(S.custom);
  const currentPreset = () => presets().find(p => p.id === S.presetId);
  const cp = () => E.compile(S.policy);
  const loaded = () => S.files.some(f => f.scan);

  function changed() {
    S.modified = true;
    store.set('styx.last', { presetId: S.presetId, policy: S.policy, modified: true });
    renderConfig();
    scheduleRun();
  }

  function selectPreset(id) {
    const p = presets().find(x => x.id === id);
    if (!p) return;
    S.presetId = id; S.policy = clone(p.policy); S.modified = false;
    store.set('styx.last', { presetId: id, policy: S.policy, modified: false });
    renderConfig();
    scheduleRun();
  }

  function rebuildUnion() {
    const types = {}, params = new Map(), texts = new Map();
    for (const f of S.files) {
      if (!f.scan) continue;
      for (const [n, t] of Object.entries(f.scan.types)) {
        if (!t.count) continue;   // defined in the log but never written
        const u = types[n] || (types[n] = { cols: t.cols, group: t.group, count: 0, bytes: 0, instCol: t.instCol, instances: new Set() });
        u.count += t.count; u.bytes += t.bytes;
        t.instances.forEach(i => u.instances.add(i));
      }
      for (const p of f.scan.params) if (!params.has(p.name)) params.set(p.name, p.value);
      for (const t of f.scan.texts) texts.set(t.text, (texts.get(t.text) || 0) + t.count);
    }
    S.U = { types, params, texts };
  }

  const ruleOf = (name) => {
    const t = S.U.types[name];
    return t ? E.ruleFor(name, t.cols, S.policy) : null;
  };

  // ---------- presets ----------
  function renderPresets() {
    $('presets').innerHTML = presets().map(p => `<div class="pwrap">
      <button class="preset" data-action="preset" data-id="${esc(p.id)}" aria-pressed="${p.id === S.presetId && !S.modified}">
        <strong>${esc(p.label)}</strong><span>${esc(p.about || 'Saved preset')}</span>
      </button>
      ${p.id.startsWith('custom:') ? `<button class="del" data-action="delete-preset" data-id="${esc(p.id)}" aria-label="Delete preset ${esc(p.label)}">Delete</button>` : ''}
    </div>`).join('');
    const box = $('modified');
    box.hidden = !S.modified;
    if (S.modified) {
      const base = currentPreset();
      box.innerHTML = `<span>Changed from ${esc(base ? base.label : 'preset')}.</span>
        <input type="text" id="preset-name" placeholder="Name, e.g. Septentrio support" maxlength="40">
        <button data-action="save-preset">Save as preset</button>
        <button class="ghost" data-action="reset">Reset</button>`;
    }
  }

  function savePreset() {
    const name = ($('preset-name').value || '').trim();
    if (!name) { $('preset-name').focus(); return; }
    const id = 'custom:' + slug(name);
    const p = { id, label: name, about: 'Saved preset', policy: clone(S.policy) };
    S.custom = S.custom.filter(x => x.id !== id).concat(p);
    store.set('styx.presets', S.custom);
    selectPreset(id);
  }

  function exportPreset() {
    const base = currentPreset();
    const label = S.modified ? (($('preset-name') || {}).value || 'Custom') : (base ? base.label : 'Custom');
    const data = { styx: 1, id: slug(label), label, about: S.modified ? 'Exported preset' : (base.about || ''), policy: S.policy };
    saveFile(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `styx-preset-${slug(label)}.json`);
  }

  async function importPreset(file) {
    try {
      const j = JSON.parse(await file.text());
      const policy = j.policy || j;
      if (typeof policy !== 'object' || Array.isArray(policy)) throw new Error('no policy');
      const label = j.label || file.name.replace(/\.json$/i, '');
      const p = { id: 'custom:' + slug(label), label, about: j.about || 'Imported preset', policy };
      S.custom = S.custom.filter(x => x.id !== p.id).concat(p);
      store.set('styx.presets', S.custom);
      selectPreset(p.id);
    } catch (e) {
      alertLine(`${file.name} is not a Styx preset file.`);
    }
  }

  function alertLine(msg) {
    const box = $('modified');
    box.hidden = false;
    box.innerHTML = `<span class="err">${esc(msg)}</span>`;
  }

  // ---------- data groups ----------
  function groupNames(gid) {
    return Object.keys(S.U.types).filter(n => isData(n) && S.U.types[n].group === gid).sort();
  }

  function groupState(gid) {
    if (!loaded()) {
      if (S.policy.groups && S.policy.groups[gid]) return 'all';
      const msgs = S.policy.messages || {};
      return Object.keys(msgs).some(n => msgs[n] && groupOf(n) === gid) ? 'some' : 'none';
    }
    const names = groupNames(gid);
    const on = names.filter(ruleOf).length;
    return on === 0 ? 'none' : on === names.length ? 'all' : 'some';
  }

  function setGroup(gid, on) {
    S.policy.groups = Object.assign({}, S.policy.groups);
    S.policy.messages = Object.assign({}, S.policy.messages);
    if (on) S.policy.groups[gid] = true; else delete S.policy.groups[gid];
    const names = new Set(groupNames(gid));
    Object.keys(S.policy.messages).forEach(n => { if (groupOf(n) === gid) names.add(n); });
    names.forEach(n => delete S.policy.messages[n]);
    changed();
  }

  function setMessage(name, rule) {
    S.policy.messages = Object.assign({}, S.policy.messages, { [name]: rule });
    changed();
  }

  function renderGroups() {
    const isLoaded = loaded();
    const list = GROUPS.concat(isLoaded && groupNames('other').length
      ? [{ id: 'other', label: 'Other', about: 'Messages Styx does not recognise.', reveals: 'Unknown content. Leave off unless you know what these are.' }] : []);
    $('groups').innerHTML = list.map(g => {
      const names = isLoaded ? groupNames(g.id) : [];
      if (isLoaded && !names.length) return '';
      const st = groupState(g.id);
      const bytes = names.reduce((s, n) => s + S.U.types[n].bytes, 0);
      const open = S.open.has('g:' + g.id);
      return `<div class="group ${st === 'none' ? 'off' : ''}">
        <div class="row">
          <input type="checkbox" data-action="group" data-id="${g.id}" ${st === 'all' ? 'checked' : ''} data-indet="${st === 'some'}" aria-label="${esc(g.label)}">
          <span class="name">${esc(g.label)}</span>
          ${isLoaded ? `<span class="meta">${plural(names.length, 'type', 'types')}, ${fmtBytes(bytes)}</span>
            <button class="expander" data-action="toggle-open" data-key="g:${g.id}" aria-expanded="${open}">${open ? 'Hide' : 'Show'}</button>` : ''}
        </div>
        <p class="about">${esc(g.about)}</p>
        ${g.reveals && st !== 'none' ? `<p class="reveals">${esc(g.reveals)}</p>` : ''}
        ${open ? `<div class="msgs">${names.map(renderMessage).join('')}</div>` : ''}
      </div>`;
    }).join('');
    document.querySelectorAll('#groups [data-indet=true]').forEach(el => { el.indeterminate = true; });
  }

  function renderMessage(name) {
    const t = S.U.types[name], r = ruleOf(name);
    const open = S.open.has('c:' + name);
    const keepNames = r ? r.keep.map(i => t.cols[i]) : [];
    const multi = t.instCol && t.instances.size > 1;
    return `<div class="msg ${r ? '' : 'off'}">
      <div class="row">
        <input type="checkbox" data-action="msg" data-name="${esc(name)}" ${r ? 'checked' : ''} aria-label="${esc(name)}">
        <span class="mono">${esc(name)}</span>
        <span class="meta">${t.count.toLocaleString()} records${multi ? `, ${t.instances.size} instances` : ''}</span>
        ${r ? `<button class="expander" data-action="toggle-open" data-key="c:${esc(name)}" aria-expanded="${open}">
          ${keepNames.length === t.cols.length ? 'All columns' : `${keepNames.length} of ${t.cols.length} columns`}</button>` : ''}
      </div>
      ${r && multi ? `<div class="opts"><label class="inline"><input type="checkbox" data-action="msg-primary" data-name="${esc(name)}" ${r.primary ? 'checked' : ''}> First instance only</label></div>` : ''}
      ${r && open ? `<div class="cols">${t.cols.map(c => {
        const locked = c === 'TimeUS';
        return `<button class="col ${locked ? 'locked' : ''}" data-action="col" data-name="${esc(name)}" data-col="${esc(c)}"
          aria-pressed="${keepNames.includes(c)}" ${locked ? 'disabled title="Time is always kept"' : ''}>${esc(c)}</button>`;
      }).join('')}</div>` : ''}
    </div>`;
  }

  // ---------- parameters ----------
  const prefixOf = (n) => n.split('_')[0];

  function materializeParams() {
    const on = cp().paramOn;
    S.policy.params = [...S.U.params.keys()].filter(on);
  }

  function renderParams() {
    const c = cp();
    const box = $('params');
    if (!loaded()) {
      const pats = S.policy.params || [];
      box.innerHTML = `<p class="note">${pats.length ? `Keeps parameters matching <span class="mono">${pats.map(esc).join(', ')}</span>.` : 'No parameters are kept.'}</p>`;
      $('param-count').textContent = '';
      return;
    }
    const names = [...S.U.params.keys()].sort();
    const on = names.filter(c.paramOn);
    $('param-count').textContent = `${on.length} of ${names.length} kept`;
    if (!names.length) { box.innerHTML = '<p class="note">These logs have no parameters.</p>'; return; }
    const q = S.paramQuery.trim().toUpperCase();
    const groups = new Map();
    for (const n of names) {
      if (q && !n.includes(q)) continue;
      const k = prefixOf(n);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(n);
    }
    const focus = document.activeElement && document.activeElement.id === 'param-search';
    box.innerHTML = `
      <input class="search" id="param-search" type="search" placeholder="Search parameters" value="${esc(S.paramQuery)}">
      <div class="quick">
        <button class="ghost" data-action="params-none">Keep none</button>
        <button class="ghost" data-action="params-all">Keep all</button>
      </div>
      <div class="plist">${[...groups].map(([k, list]) => {
        const n = list.filter(c.paramOn).length;
        const open = q || S.open.has('p:' + k);
        return `<div class="pgroup">
          <div class="row">
            <input type="checkbox" data-action="pgroup" data-id="${esc(k)}" ${n === list.length ? 'checked' : ''} data-indet="${n > 0 && n < list.length}" aria-label="${esc(k)} parameters">
            <span class="mono">${esc(k)}_</span>
            <span class="meta">${n} of ${list.length}</span>
            ${q ? '' : `<button class="expander" data-action="toggle-open" data-key="p:${esc(k)}" aria-expanded="${!!open}">${open ? 'Hide' : 'Show'}</button>`}
          </div>
          ${open ? list.map(p => `<label class="pitem"><input type="checkbox" data-action="param" data-name="${esc(p)}" ${c.paramOn(p) ? 'checked' : ''}>
            <span class="mono">${esc(p)}</span><span class="val">${esc(+Number(S.U.params.get(p)).toPrecision(6))}</span></label>`).join('') : ''}
        </div>`;
      }).join('') || '<p class="note" style="padding:8px 10px">No match.</p>'}</div>`;
    box.querySelectorAll('[data-indet=true]').forEach(el => { el.indeterminate = true; });
    if (focus) { const s = $('param-search'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  }

  // ---------- text messages ----------
  function materializeTexts() {
    const on = cp().textOn;
    S.policy.texts = [...S.U.texts.keys()].filter(on);
    S.policy.text = [];
  }

  function renderTexts() {
    const c = cp();
    const box = $('texts');
    if (!loaded()) {
      const n = (S.policy.text || []).length + (S.policy.texts || []).length;
      box.innerHTML = `<p class="note">${n ? 'This preset keeps some text lines. Load a log to see which.' : 'No text messages are kept.'}</p>`;
      $('text-count').textContent = '';
      return;
    }
    const texts = [...S.U.texts.keys()];
    const on = texts.filter(c.textOn);
    $('text-count').textContent = `${on.length} of ${texts.length} kept`;
    if (!texts.length) { box.innerHTML = '<p class="note">These logs have no text messages.</p>'; return; }
    box.innerHTML = `
      <p class="hint">Text lines often name the board, GPS and firmware. Tick only what the recipient needs.</p>
      <div class="quick"><button class="ghost" data-action="texts-none">Keep none</button></div>
      <div class="plist">${texts.map(t => `<label class="titem"><input type="checkbox" data-action="text" data-text="${esc(t)}" ${c.textOn(t) ? 'checked' : ''}>
        <span class="mono">${esc(t)}</span><span class="n">${S.U.texts.get(t) > 1 ? '×' + S.U.texts.get(t) : ''}</span></label>`).join('')}</div>`;
  }

  function renderConfig() {
    renderPresets();
    $('primary').checked = S.policy.primary !== false;
    renderGroups();
    renderParams();
    renderTexts();
  }

  // ---------- files ----------
  async function addFiles(list) {
    const files = Array.from(list).filter(f => f.size > 0);
    for (const file of files) {
      const f = { id: 'f' + nextId++, name: file.name, size: file.size, scan: null, report: null, bytes: null, error: null };
      S.files.push(f);
      renderFiles();
      try {
        const res = await backend.load(f.id, await file.arrayBuffer());
        f.scan = res.scan;
        if (!Object.keys(f.scan.types).length) f.error = 'No ArduPilot log data found in this file.';
      } catch (e) {
        f.error = 'Could not read this file: ' + e.message;
      }
      rebuildUnion();
      renderConfig();
      renderFiles();
      scheduleRun(0);
    }
  }

  function removeFile(id) {
    S.files = S.files.filter(f => f.id !== id);
    backend.drop(id);
    rebuildUnion();
    renderConfig();
    renderFiles();
  }

  function scheduleRun(delay) {
    clearTimeout(runTimer);
    runTimer = setTimeout(runAll, delay === undefined ? 200 : delay);
  }

  async function runAll() {
    const gen = ++runGen;
    const targets = S.files.filter(f => f.scan && !f.error);
    if (!targets.length) return;
    $('busy').hidden = false;
    const policy = clone(S.policy);
    for (const f of targets) {
      try {
        const res = await backend.run(f.id, policy);
        if (gen !== runGen) return;
        f.report = res.report; f.bytes = res.bytes; f.tag = outTag();
      } catch (e) {
        if (gen !== runGen) return;
        f.error = 'Processing failed: ' + e.message;
      }
      renderFile(f);
    }
    if (gen === runGen) $('busy').hidden = true;
    updateBar();
  }

  function outTag() {
    const p = currentPreset();
    const base = p ? (p.id.startsWith('custom:') ? slug(p.label) : p.id) : 'custom';
    return S.modified ? base + '-edited' : base;
  }
  const outName = (f) => f.name.replace(/\.bin$/i, '') + '_' + (f.tag || outTag()) + '.bin';

  function updateBar() {
    const n = S.files.length;
    $('files-bar').hidden = !n;
    $('empty').hidden = !!n;
    $('drop').classList.toggle('compact', !!n);
    $('files-count').textContent = plural(n, 'log', 'logs');
    $('download-all').hidden = n < 2;
  }

  function renderFiles() {
    const box = $('files');
    const have = new Set(S.files.map(f => f.id));
    [...box.children].forEach(el => { if (!have.has(el.dataset.id)) el.remove(); });
    for (const f of S.files) {
      if (!box.querySelector(`[data-id="${f.id}"]`)) {
        const el = document.createElement('article');
        el.className = 'file'; el.dataset.id = f.id;
        box.appendChild(el);
      }
      renderFile(f);
    }
    updateBar();
  }

  // Original log split into data groups; segment width = share of the original bytes.
  function splitBar(f) {
    const segs = new Map();
    const add = (key, label, bytes, keptBytes) => {
      const s = segs.get(key) || { label, bytes: 0, kept: 0 };
      s.bytes += bytes; s.kept += keptBytes;
      segs.set(key, s);
    };
    const labels = Object.fromEntries(GROUPS.map(g => [g.id, g.label]));
    for (const [n, t] of Object.entries(f.scan.types)) {
      const c = f.report && f.report.counts[n];
      const frac = c && c.in ? c.kept / c.in : 0;
      if (n === 'PARM') add('params', 'Parameters', t.bytes, t.bytes * frac);
      else if (n === 'MSG') add('text', 'Text messages', t.bytes, t.bytes * frac);
      else if (n === 'FILE') add('files', 'Embedded files', t.bytes, 0);
      else if (TABLES.has(n)) add('tables', 'Format tables', t.bytes, t.bytes * frac);
      else add(t.group, labels[t.group] || 'Other', t.bytes, t.bytes * frac);
    }
    const list = [...segs.values()].filter(s => s.bytes > 0).sort((a, b) => b.bytes - a.bytes);
    const bar = list.map(s => {
      const k = s.bytes ? s.kept / s.bytes : 0;
      const cls = k > 0.999 ? 'kept' : k > 0 ? 'part' : '';
      const state = k > 0.999 ? 'kept' : k > 0 ? `${Math.round(k * 100)}% kept` : 'removed';
      return `<div class="seg ${cls}" style="flex-grow:${s.bytes};--k:${Math.max(8, Math.round(k * 100))}%" title="${esc(s.label)}: ${fmtBytes(s.bytes)}, ${state}"></div>`;
    }).join('');
    const keptGroups = list.filter(s => s.kept > 0).map(s => s.label);
    return `<div class="split">
      <div class="bar" role="img" aria-label="Original log by data group. Kept: ${esc(keptGroups.join(', ') || 'nothing')}">${bar}</div>
      <div class="legend">
        <span><i></i>In the shared file</span><span><i class="g"></i>Removed</span>
        ${list.slice(0, 4).map(s => `<span><b>${esc(s.label)}</b> ${fmtBytes(s.bytes)}</span>`).join('')}
      </div>
    </div>`;
  }

  function renderFile(f) {
    const el = document.querySelector(`#files [data-id="${f.id}"]`);
    if (!el) return;
    const r = f.report;
    const head = `<div class="file-head"><span class="fname">${esc(f.name)}</span>
      <span class="size">${r ? `${fmtBytes(r.inBytes)} to ${fmtBytes(r.outBytes)}` : fmtBytes(f.size)}</span>
      <button class="x" data-action="remove" data-id="${f.id}" aria-label="Remove ${esc(f.name)}">Remove</button></div>`;
    if (f.error) { el.innerHTML = head + `<p class="err">${esc(f.error)}</p>`; return; }
    if (!f.scan || !r) { el.innerHTML = head + '<p class="note">Reading log…</p>'; return; }

    const stat = (v, label) => `<div class="stat"><b>${v}</b><small>${label}</small></div>`;
    const keptTypes = Object.entries(r.counts).filter(([n, c]) => c.kept && isData(n)).map(([n]) => n).sort();
    const dist = r.distance == null ? '–' : r.distance >= 1000 ? (r.distance / 1000).toFixed(2) + ' km' : r.distance.toFixed(0) + ' m';
    el.innerHTML = head + splitBar(f) +
      `<div class="stats">
        ${stat(fmtDur(f.scan.duration), 'log length')}
        ${stat(r.maxAlt != null ? r.maxAlt.toFixed(1) + ' m' : '–', 'max height above home')}
        ${stat(r.maxSpeed != null ? r.maxSpeed.toFixed(1) + ' m/s' : '–', r.speedSource === 'track' ? 'max speed, from track' : 'max ground speed')}
        ${stat(dist, 'distance flown')}
      </div>` +
      (r.track.length ? `<div class="plots"><canvas data-k="track" aria-label="Flight track"></canvas><canvas data-k="alt" aria-label="Height over time"></canvas></div>`
                      : `<p class="note">No position data is kept, so there is no track to show.</p>`) +
      `<details><summary>Shared file holds ${plural(keptTypes.length, 'data type', 'data types')}, ${plural(r.params.length, 'parameter', 'parameters')}, ${plural(r.texts.length, 'text line', 'text lines')}</summary>
        <ul class="leaves">
          ${keptTypes.map(n => `<li><span class="mono">${esc(n)}</span> ${r.counts[n].kept.toLocaleString()} records${r.droppedCols[n] ? `, without ${esc(r.droppedCols[n].join(', '))}` : ''}</li>`).join('')}
          ${r.params.length ? `<li>Parameters: <span class="mono">${r.params.map(esc).join(', ')}</span></li>` : ''}
          ${r.texts.map(t => `<li>Text: <span class="mono">${esc(t)}</span></li>`).join('')}
          ${r.skippedBytes ? `<li>${r.skippedBytes.toLocaleString()} unreadable bytes left out</li>` : ''}
        </ul>
      </details>
      <div class="file-foot"><button data-action="download" data-id="${f.id}">Download ${esc(outName(f))}</button></div>`;
    if (r.track.length) {
      plotTrack(el.querySelector('[data-k=track]'), r.track);
      plotAlt(el.querySelector('[data-k=alt]'), r.track);
    }
  }

  function saveFile(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  const download = (f) => { if (f.bytes) saveFile(new Blob([f.bytes], { type: 'application/octet-stream' }), outName(f)); };

  // ---------- plots ----------
  function setup(cv) {
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    ctx.font = '12px "IBM Plex Sans", system-ui, sans-serif';
    return { ctx, w, h, v: (n) => css.getPropertyValue(n).trim() };
  }

  function plotTrack(cv, pts) {
    const { ctx, w, h, v } = setup(cv);
    const lat0 = pts[0].lat, k = Math.cos(lat0 * Math.PI / 180), M = 111320;
    const xy = pts.map(p => [(p.lng - pts[0].lng) * k * M, (p.lat - lat0) * M]);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of xy) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const pad = 24, span = Math.max(x1 - x0, y1 - y0, 10);
    const s = Math.min(w - 2 * pad, h - 2 * pad) / span;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const P = ([x, y]) => [w / 2 + (x - cx) * s, h / 2 - (y - cy) * s];
    ctx.strokeStyle = v('--track'); ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath();
    xy.forEach((q, i) => { const [a, b] = P(q); if (i) ctx.lineTo(a, b); else ctx.moveTo(a, b); });
    ctx.stroke();
    const [sx, sy] = P(xy[0]), [ex, ey] = P(xy[xy.length - 1]);
    ctx.fillStyle = v('--track'); ctx.beginPath(); ctx.arc(sx, sy, 5, 0, 7); ctx.fill();
    ctx.fillStyle = v('--ink'); ctx.fillRect(ex - 4, ey - 4, 8, 8);
    const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
    const len = nice.find(m => m * s > 50) || nice[nice.length - 1];
    ctx.strokeStyle = v('--muted'); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(10, h - 12); ctx.lineTo(10 + len * s, h - 12); ctx.stroke();
    ctx.fillStyle = v('--muted');
    ctx.fillText(len >= 1000 ? len / 1000 + ' km' : len + ' m', 14 + len * s, h - 8);
    ctx.fillText('Track, ● start ■ end', 10, 16);
  }

  function plotAlt(cv, pts) {
    const { ctx, w, h, v } = setup(cv);
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const alts = pts.map(p => p.alt).filter(isFinite);
    const lo = Math.min(0, ...alts), hi = Math.max(...alts, lo + 1);
    const raw = (hi - lo) / 4, mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(st => st >= raw);
    const a0 = Math.floor(lo / step) * step, a1 = Math.ceil(hi / step) * step;
    const L = 40, R = 10, T = 26, B = 22;
    const X = (t) => L + (t - t0) / ((t1 - t0) || 1) * (w - L - R);
    const Y = (a) => h - B - (a - a0) / (a1 - a0) * (h - T - B);
    ctx.fillStyle = v('--muted'); ctx.strokeStyle = v('--grid'); ctx.lineWidth = 1;
    for (let a = a0; a <= a1 + step / 2; a += step) {
      const y = Y(a);
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke();
      ctx.fillText(String(+a.toFixed(2)), 4, y + 4);
    }
    ctx.fillText('Height above home (m)', L, 16);
    ctx.fillText('0:00', L, h - 6);
    const end = fmtDur(t1 - t0);
    ctx.fillText(end, w - R - ctx.measureText(end).width, h - 6);
    ctx.strokeStyle = v('--alt'); ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    for (const p of pts) {
      if (!isFinite(p.alt)) continue;
      if (started) ctx.lineTo(X(p.t), Y(p.alt)); else { ctx.moveTo(X(p.t), Y(p.alt)); started = true; }
    }
    ctx.stroke();
  }

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const a = t.dataset.action;
    if (t.type === 'checkbox') return;          // handled on change
    switch (a) {
      case 'preset': selectPreset(t.dataset.id); break;
      case 'delete-preset': {
        S.custom = S.custom.filter(p => p.id !== t.dataset.id);
        store.set('styx.presets', S.custom);
        if (S.presetId === t.dataset.id) selectPreset('customer'); else renderPresets();
        break;
      }
      case 'save-preset': savePreset(); break;
      case 'reset': selectPreset(currentPreset() ? S.presetId : 'customer'); break;
      case 'export': exportPreset(); break;
      case 'import': $('import-file').click(); break;
      case 'toggle-open': {
        const k = t.dataset.key;
        if (S.open.has(k)) S.open.delete(k); else S.open.add(k);
        renderConfig();
        break;
      }
      case 'col': {
        const name = t.dataset.name, col = t.dataset.col, r = ruleOf(name), cols = S.U.types[name].cols;
        let keep = r.keep.map(i => cols[i]);
        keep = keep.includes(col) ? keep.filter(c => c !== col) : cols.filter(c => keep.includes(c) || c === col);
        setMessage(name, { cols: keep.length === cols.length ? '*' : keep, primary: r.primary });
        break;
      }
      case 'params-none': S.policy.params = []; changed(); break;
      case 'params-all': S.policy.params = ['*']; changed(); break;
      case 'texts-none': S.policy.text = []; S.policy.texts = []; changed(); break;
      case 'remove': removeFile(t.dataset.id); break;
      case 'clear': S.files.slice().forEach(f => backend.drop(f.id)); S.files = []; rebuildUnion(); renderConfig(); renderFiles(); break;
      case 'download': download(S.files.find(f => f.id === t.dataset.id)); break;
      case 'download-all': S.files.filter(f => f.bytes).forEach((f, i) => setTimeout(() => download(f), i * 400)); break;
    }
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'primary') { S.policy.primary = t.checked; changed(); return; }
    if (t.id === 'file') { addFiles(t.files); t.value = ''; return; }
    if (t.id === 'import-file') { if (t.files[0]) importPreset(t.files[0]); t.value = ''; return; }
    const a = t.dataset.action;
    if (a === 'group') setGroup(t.dataset.id, t.checked);
    else if (a === 'msg') setMessage(t.dataset.name, t.checked ? { cols: '*', primary: S.policy.primary !== false } : false);
    else if (a === 'msg-primary') {
      const r = ruleOf(t.dataset.name), cols = S.U.types[t.dataset.name].cols;
      setMessage(t.dataset.name, { cols: r.keep.length === cols.length ? '*' : r.keep.map(i => cols[i]), primary: t.checked });
    } else if (a === 'param' || a === 'pgroup') {
      materializeParams();
      const set = new Set(S.policy.params);
      const names = a === 'param' ? [t.dataset.name] : [...S.U.params.keys()].filter(n => prefixOf(n) === t.dataset.id);
      names.forEach(n => (t.checked ? set.add(n) : set.delete(n)));
      S.policy.params = [...set];
      changed();
    } else if (a === 'text') {
      materializeTexts();
      const set = new Set(S.policy.texts);
      if (t.checked) set.add(t.dataset.text); else set.delete(t.dataset.text);
      S.policy.texts = [...set];
      changed();
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'param-search') { S.paramQuery = e.target.value; renderParams(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.id === 'preset-name' && e.key === 'Enter') savePreset();
    if (e.target.id === 'drop' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); $('file').click(); }
  });

  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => { e.preventDefault(); if (!drop.contains(e.target)) addFiles(e.dataTransfer.files); });

  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => S.files.forEach(renderFile), 150); });

  renderConfig();
  updateBar();
})();
