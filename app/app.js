// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Aditya Suresh (sasr-e24)
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
    active: null,
    pane: 'data',
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
  const activeFile = () => S.files.find(f => f.id === S.active) || null;

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


  // ---------- presets (top bar) ----------
  function renderPresets() {
    const editing = S.modified;
    $('presets').innerHTML = presets().map(p =>
      `<button class="preset" data-action="preset" data-id="${esc(p.id)}" title="${esc(p.about || '')}" aria-pressed="${p.id === S.presetId && !editing}">${esc(p.label)}</button>`
    ).join('') + (editing ? '<button class="preset custom" aria-pressed="true" disabled>Edited</button>' : '');
    const box = $('modified');
    box.hidden = !editing;
    if (editing) {
      const base = currentPreset();
      box.innerHTML = `<span>Edited from ${esc(base ? base.label : 'preset')}</span>
        <input type="text" id="preset-name" placeholder="Name for this preset" maxlength="40" aria-label="Preset name">
        <button class="tool" data-action="save-preset">Save preset</button>
        <button class="tool" data-action="reset">Reset</button>`;
    }
    const cur = currentPreset();
    if (!editing && cur && cur.id.startsWith('custom:')) {
      box.hidden = false;
      box.innerHTML = `<span>Saved preset</span><button class="tool" data-action="delete-preset" data-id="${esc(cur.id)}">Delete preset</button>`;
    }
  }

  function savePreset() {
    const name = ($('preset-name').value || '').trim();
    if (!name) { $('preset-name').focus(); return; }
    const id = 'custom:' + slug(name);
    S.custom = S.custom.filter(x => x.id !== id).concat({ id, label: name, about: 'Saved preset', policy: clone(S.policy) });
    store.set('styx.presets', S.custom);
    selectPreset(id);
  }

  function exportPreset() {
    const base = currentPreset();
    const typed = $('preset-name') && $('preset-name').value.trim();
    const label = S.modified ? (typed || 'Custom') : (base ? base.label : 'Custom');
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
      const box = $('modified');
      box.hidden = false;
      box.innerHTML = `<span class="err">${esc(file.name)} is not a Styx preset file.</span>`;
    }
  }

  // ---------- data groups ----------
  function groupNames(gid) {
    return Object.keys(S.U.types).filter(n => isData(n) && S.U.types[n].group === gid).sort((a, b) => S.U.types[b].bytes - S.U.types[a].bytes);
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

  function allGroups() {
    const list = GROUPS.slice();
    if (groupNames('other').length) list.push({ id: 'other', label: 'Unknown / custom', about: 'Messages Styx does not recognise, such as in-house or script logging.', reveals: 'Unknown content. Leave off unless you know what these are.' });
    return list;
  }

  function renderGroups() {
    const isLoaded = loaded();
    const rows = allGroups().map(g => ({ g, names: isLoaded ? groupNames(g.id) : [] }))
      .filter(x => !isLoaded || x.names.length)
      .map(x => Object.assign(x, { bytes: x.names.reduce((s, n) => s + S.U.types[n].bytes, 0), records: x.names.reduce((s, n) => s + S.U.types[n].count, 0) }));
    if (isLoaded) rows.sort((a, b) => b.bytes - a.bytes);
    const max = Math.max(1, ...rows.map(r => r.bytes));
    let onTypes = 0, allTypes = 0;
    $('groups').innerHTML = rows.map(({ g, names, bytes, records }) => {
      const st = groupState(g.id);
      const open = S.open.has('g:' + g.id);
      allTypes += names.length; onTypes += names.filter(ruleOf).length;
      const keptBytes = names.filter(ruleOf).reduce((s, n) => s + S.U.types[n].bytes, 0);
      let html = `<tr class="g ${st}">
        <td class="ck"><input type="checkbox" data-action="group" data-id="${g.id}" ${st === 'all' ? 'checked' : ''} data-indet="${st === 'some'}" aria-label="${esc(g.label)}"></td>
        <td><button class="caret" data-action="toggle-open" data-key="g:${g.id}" aria-expanded="${open}">${esc(g.label)}</button></td>
        <td class="n">${isLoaded ? records.toLocaleString() : ''}</td><td class="n"></td>
        <td class="n">${isLoaded ? fmtBytes(bytes) : ''}</td>
        <td class="sh">${isLoaded ? `<div class="share" title="${fmtBytes(keptBytes)} of ${fmtBytes(bytes)} kept"><i class="${st !== 'none' ? 'k' : ''}" style="width:${Math.max(1, bytes / max * 100)}%"></i></div>` : ''}</td></tr>`;
      if (open) {
        html += `<tr class="note"><td></td><td colspan="5">${esc(g.about)}${g.reveals ? ` <span class="warn">${esc(g.reveals)}</span>` : ''}</td></tr>`;
        html += names.map(renderMessage).join('');
        if (!isLoaded) html += `<tr class="note"><td></td><td colspan="5">Open a log to pick single messages and columns.</td></tr>`;
      }
      return html;
    }).join('');
    document.querySelectorAll('#groups [data-indet=true]').forEach(el => { el.indeterminate = true; });
    $('data-count').textContent = isLoaded ? `${onTypes}/${allTypes}` : '';
  }

  function renderMessage(name) {
    const t = S.U.types[name], r = ruleOf(name);
    const open = r && S.open.has('c:' + name);
    const keepNames = r ? r.keep.map(i => t.cols[i]) : [];
    const multi = t.instCol && t.instances.size > 1;
    let html = `<tr class="m ${r ? 'on' : 'off'}">
      <td class="ck"><input type="checkbox" data-action="msg" data-name="${esc(name)}" ${r ? 'checked' : ''} aria-label="${esc(name)}"></td>
      <td class="name">${esc(name)}${multi ? `<span class="inst">${t.instances.size} instances${r && r.primary ? ', first kept' : ''}</span>` : ''}</td>
      <td class="n">${t.count.toLocaleString()}</td>
      <td class="n">${r ? `<button class="colsbtn" data-action="toggle-open" data-key="c:${esc(name)}" aria-expanded="${!!open}" title="Choose columns">${keepNames.length}/${t.cols.length}</button>` : '–'}</td>
      <td class="n">${fmtBytes(t.bytes)}</td><td class="sh"></td></tr>`;
    if (open) {
      html += `<tr class="colsrow"><td></td><td colspan="5"><div class="chips">${t.cols.map(c => {
        const locked = c === 'TimeUS';
        return `<button class="chip" data-action="col" data-name="${esc(name)}" data-col="${esc(c)}" aria-pressed="${keepNames.includes(c)}" ${locked ? 'disabled title="Time is always kept"' : ''}>${esc(c)}</button>`;
      }).join('')}${multi ? `<label class="inline"><input type="checkbox" data-action="msg-primary" data-name="${esc(name)}" ${r.primary ? 'checked' : ''}> First instance only</label>` : ''}</div></td></tr>`;
    }
    return html;
  }

  // ---------- parameters ----------
  const prefixOf = (n) => n.split('_')[0];

  function materializeParams() {
    const on = cp().paramOn;
    S.policy.params = [...S.U.params.keys()].filter(on);
  }

  function renderParams() {
    const c = cp();
    const box = $('pane-params');
    const names = [...S.U.params.keys()].sort();
    const on = names.filter(c.paramOn);
    $('param-count').textContent = loaded() ? `${on.length}/${names.length}` : '';
    if (!loaded()) {
      const pats = S.policy.params || [];
      box.innerHTML = `<p class="empty">${pats.length ? `This preset keeps parameters matching <span class="mono">${pats.map(esc).join('  ')}</span>. Open a log to pick single parameters.` : 'This preset keeps no parameters.'}</p>`;
      return;
    }
    if (!names.length) { box.innerHTML = '<p class="empty">These logs have no parameters.</p>'; return; }
    const q = S.paramQuery.trim().toUpperCase();
    const groups = new Map();
    for (const n of names) {
      if (q && !n.includes(q)) continue;
      const k = prefixOf(n);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(n);
    }
    const focus = document.activeElement && document.activeElement.id === 'param-search';
    box.innerHTML = `<div class="ptools">
        <input type="search" id="param-search" placeholder="Search parameters" value="${esc(S.paramQuery)}" aria-label="Search parameters">
        <button class="tool" data-action="params-none">Keep none</button>
        <button class="tool" data-action="params-all">Keep all</button>
        <span class="hint">${on.length} of ${names.length} kept</span>
      </div>
      <table class="grid"><thead><tr><th class="ck"></th><th>Parameter</th><th class="n">Kept</th><th class="n">Value</th></tr></thead><tbody>
      ${[...groups].map(([k, list]) => {
        const n = list.filter(c.paramOn).length;
        const open = q || S.open.has('p:' + k);
        return `<tr class="g ${n ? '' : 'none'}">
            <td class="ck"><input type="checkbox" data-action="pgroup" data-id="${esc(k)}" ${n === list.length ? 'checked' : ''} data-indet="${n > 0 && n < list.length}" aria-label="${esc(k)} parameters"></td>
            <td><button class="caret mono" data-action="toggle-open" data-key="p:${esc(k)}" aria-expanded="${!!open}">${esc(k)}_</button></td>
            <td class="n">${n}/${list.length}</td><td></td></tr>` +
          (open ? list.map(p => `<tr class="m ${c.paramOn(p) ? 'on' : 'off'}"><td class="ck"><input type="checkbox" data-action="param" data-name="${esc(p)}" ${c.paramOn(p) ? 'checked' : ''} aria-label="${esc(p)}"></td>
            <td class="name">${esc(p)}</td><td></td><td class="val">${esc(+Number(S.U.params.get(p)).toPrecision(6))}</td></tr>`).join('') : '');
      }).join('') || '<tr><td></td><td class="empty" colspan="3">No match.</td></tr>'}
      </tbody></table>`;
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
    const box = $('pane-texts');
    const texts = [...S.U.texts.keys()];
    const on = texts.filter(c.textOn);
    $('text-count').textContent = loaded() ? `${on.length}/${texts.length}` : '';
    if (!loaded()) {
      const n = (S.policy.text || []).length + (S.policy.texts || []).length;
      box.innerHTML = `<p class="empty">${n ? 'This preset keeps some text lines. Open a log to see which.' : 'This preset keeps no text messages.'}</p>`;
      return;
    }
    if (!texts.length) { box.innerHTML = '<p class="empty">These logs have no text messages.</p>'; return; }
    box.innerHTML = `<div class="ptools">
        <button class="tool" data-action="texts-none">Keep none</button>
        <span class="hint">Text lines often name the board, GPS and firmware. Tick only what the recipient needs.</span>
      </div>
      <table class="grid"><thead><tr><th class="ck"></th><th>Line</th><th class="n">Times</th></tr></thead><tbody>
      ${texts.map(t => `<tr class="m ${c.textOn(t) ? 'on' : 'off'}"><td class="ck"><input type="checkbox" data-action="text" data-text="${esc(t)}" ${c.textOn(t) ? 'checked' : ''} aria-label="Keep line"></td>
        <td class="mono">${esc(t)}</td><td class="n">${S.U.texts.get(t)}</td></tr>`).join('')}
      </tbody></table>`;
  }

  function renderPanes() {
    document.querySelectorAll('.pane-btn').forEach(b => b.setAttribute('aria-selected', b.dataset.pane === S.pane));
    $('pane-data').hidden = S.pane !== 'data';
    $('pane-params').hidden = S.pane !== 'params';
    $('pane-texts').hidden = S.pane !== 'texts';
  }

  function renderConfig() {
    renderPresets();
    renderPanes();
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
      S.active = f.id;
      document.body.dataset.state = 'busy';
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
    if (S.active === id) S.active = S.files.length ? S.files[S.files.length - 1].id : null;
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
    if (!targets.length) { document.body.dataset.state = 'idle'; renderFiles(); return; }
    document.body.dataset.state = 'busy';
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
      if (f.id === S.active) renderPanel();
    }
    if (gen === runGen) document.body.dataset.state = 'idle';
    renderFiles();
  }

  function outTag() {
    const p = currentPreset();
    const base = p ? (p.id.startsWith('custom:') ? slug(p.label) : p.id) : 'custom';
    return S.modified ? base + '-edited' : base;
  }
  const outName = (f) => f.name.replace(/\.bin$/i, '') + '_' + (f.tag || outTag()) + '.bin';

  function renderFiles() {
    $('tabs').innerHTML = S.files.map(f => `<div class="tab" role="tab" tabindex="0" data-action="tab" data-id="${f.id}" aria-selected="${f.id === S.active}" title="${esc(f.name)}">
        ${f.error ? '<span class="dot err"></span>' : !f.report ? '<span class="dot"></span>' : ''}${esc(f.name)}
        <button class="x" data-action="remove" data-id="${f.id}" aria-label="Close ${esc(f.name)}">×</button></div>`).join('') +
      (S.files.length ? '<label class="tab add" for="file" tabindex="0">+ add log</label>' : '');
    $('drop').hidden = S.files.length > 0;
    const ready = S.files.filter(f => f.bytes).length;
    const dl = $('download-all');
    dl.disabled = !ready;
    dl.textContent = ready > 1 ? `Export ${ready} logs` : 'Export';
    renderPanel();
  }

  function renderPanel() {
    const box = $('panel');
    const f = activeFile();
    if (!f) {
      box.innerHTML = `<div class="panel-empty"><b>No log open</b>Open or drop one or more .bin logs. The preview of what leaves shows here.</div>`;
      return;
    }
    if (f.error) { box.innerHTML = `<h4>${esc(f.name)}</h4><p class="err">${esc(f.error)}</p>`; return; }
    const r = f.report;
    if (!f.scan || !r) { box.innerHTML = `<h4>${esc(f.name)}</h4><p class="busy">Reading log…</p>`; return; }
    const keptTypes = Object.entries(r.counts).filter(([n, c]) => c.kept && isData(n)).map(([n]) => n).sort();
    const dist = r.distance == null ? '–' : r.distance >= 1000 ? (r.distance / 1000).toFixed(2) + ' km' : r.distance.toFixed(0) + ' m';
    box.innerHTML =
      (r.track.length ? `<h4>Track</h4><canvas class="trk" aria-label="Flight track"></canvas><h4>Height above home</h4><canvas class="alt" aria-label="Height over time"></canvas>`
                      : `<h4>Track</h4><p class="busy">No position data is kept, so there is no track to show.</p>`) +
      `<div class="kv">
        <span>Log length</span><b>${fmtDur(f.scan.duration)}</b>
        <span>Max height above home</span><b>${r.maxAlt != null ? r.maxAlt.toFixed(1) + ' m' : '–'}</b>
        <span>${r.speedSource === 'track' ? 'Max speed, from track' : 'Max ground speed'}</span><b>${r.maxSpeed != null ? r.maxSpeed.toFixed(1) + ' m/s' : '–'}</b>
        <span>Distance</span><b>${dist}</b>
      </div>
      <div class="out">
        <div class="sz" id="out-size">${fmtBytes(r.inBytes)} → ${fmtBytes(r.outBytes)}</div>
        <div class="sub">${keptTypes.length} data types · ${r.params.length} of ${f.scan.params.length} parameters · ${r.texts.length} of ${f.scan.texts.length} text lines</div>
        <button class="go" data-action="download" data-id="${f.id}" title="${esc(outName(f))}">Download ${esc(outName(f))}</button>
      </div>
      <details id="review"><summary>What leaves in this file</summary>
        <ul class="leaves">
          ${keptTypes.map(n => `<li><span class="mono">${esc(n)}</span> ${r.counts[n].kept.toLocaleString()} records${r.droppedCols[n] ? `, without ${esc(r.droppedCols[n].join(', '))}` : ''}</li>`).join('')}
          ${r.params.length ? `<li>Parameters: <span class="mono">${r.params.map(esc).join(', ')}</span></li>` : ''}
          ${r.texts.map(t => `<li>Text: <span class="mono">${esc(t)}</span></li>`).join('')}
          ${r.skippedBytes ? `<li>${r.skippedBytes.toLocaleString()} unreadable bytes left out</li>` : ''}
        </ul>
      </details>`;
    if (r.track.length) {
      plotTrack(box.querySelector('canvas.trk'), r.track);
      plotAlt(box.querySelector('canvas.alt'), r.track);
    }
  }

  function saveFile(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  const download = (f) => { if (f && f.bytes) saveFile(new Blob([f.bytes], { type: 'application/octet-stream' }), outName(f)); };

  // ---------- plots ----------
  function setup(cv) {
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    ctx.font = '12px "Plex Cond", system-ui, sans-serif';
    return { ctx, w, h, v: (n) => css.getPropertyValue(n).trim() };
  }

  function plotTrack(cv, pts) {
    const { ctx, w, h, v } = setup(cv);
    const lat0 = pts[0].lat, k = Math.cos(lat0 * Math.PI / 180), M = 111320;
    const xy = pts.map(p => [(p.lng - pts[0].lng) * k * M, (p.lat - lat0) * M]);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of xy) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const pad = 20, span = Math.max(x1 - x0, y1 - y0, 10);
    const s = Math.min(w - 2 * pad, h - 2 * pad) / span;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const P = ([x, y]) => [w / 2 + (x - cx) * s, h / 2 - (y - cy) * s];
    ctx.strokeStyle = v('--amber'); ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
    ctx.beginPath();
    xy.forEach((q, i) => { const [a, b] = P(q); if (i) ctx.lineTo(a, b); else ctx.moveTo(a, b); });
    ctx.stroke();
    const [sx, sy] = P(xy[0]);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(sx, sy, 4, 0, 7); ctx.fill();
    const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
    const len = nice.find(m => m * s > 50) || nice[nice.length - 1];
    ctx.strokeStyle = v('--muted'); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(10, h - 12); ctx.lineTo(10 + len * s, h - 12); ctx.stroke();
    ctx.fillStyle = v('--muted');
    ctx.fillText(len >= 1000 ? len / 1000 + ' km' : len + ' m', 14 + len * s, h - 8);
  }

  function plotAlt(cv, pts) {
    const { ctx, w, h, v } = setup(cv);
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const alts = pts.map(p => p.alt).filter(isFinite);
    const lo = Math.min(0, ...alts), hi = Math.max(...alts, lo + 1);
    const L = 34, R = 8, T = 8, B = 16;
    const X = (t) => L + (t - t0) / ((t1 - t0) || 1) * (w - L - R);
    const Y = (a) => h - B - (a - lo) / (hi - lo) * (h - T - B);
    ctx.fillStyle = v('--muted'); ctx.strokeStyle = '#2f353b'; ctx.lineWidth = 1;
    [lo, hi].forEach(a => { ctx.beginPath(); ctx.moveTo(L, Y(a)); ctx.lineTo(w - R, Y(a)); ctx.stroke(); ctx.fillText(Math.round(a) + ' m', 4, Y(a) + 4); });
    ctx.fillText('0:00', L, h - 3);
    const end = fmtDur(t1 - t0);
    ctx.fillText(end, w - R - ctx.measureText(end).width, h - 3);
    ctx.strokeStyle = v('--alt'); ctx.lineWidth = 1.4;
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
    const t = e.target.closest('[data-action], [data-pane]');
    if (!t) return;
    if (t.dataset.pane) { S.pane = t.dataset.pane; renderPanes(); return; }
    if (t.type === 'checkbox') return;          // handled on change
    switch (t.dataset.action) {
      case 'preset': selectPreset(t.dataset.id); break;
      case 'delete-preset':
        S.custom = S.custom.filter(p => p.id !== t.dataset.id);
        store.set('styx.presets', S.custom);
        selectPreset('customer');
        break;
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
      case 'tab': S.active = t.dataset.id; renderFiles(); break;
      case 'remove': e.stopPropagation(); removeFile(t.dataset.id); break;
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
    const t = e.target;
    if (t.id === 'preset-name' && e.key === 'Enter') savePreset();
    if ((e.key === 'Enter' || e.key === ' ') && t.matches('label[for=file], .tab[data-action=tab]')) {
      e.preventDefault();
      if (t.matches('label')) $('file').click(); else { S.active = t.dataset.id; renderFiles(); }
    }
  });

  // whole window accepts dropped logs
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('over'); });
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('over'); } });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; document.body.classList.remove('over');
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(renderPanel, 150); });

  renderConfig();
  renderFiles();
})();
