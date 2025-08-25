// js/kb-ui.js — Suggest (RQ1), Prune (RQ2), Explain (RQ3) UI, with safe fallbacks and WoZ merge.
// Expects: window.graph, window.paper, JointJS loaded. Uses KB.core if available; otherwise degrades gracefully.

window.KB = window.KB || {};
KB.ui = (function () {
  const LINK_COLOR = '#9aa0a6';
  const TARGET_MARKER = { type: 'path', d: 'M 10 -5 L 0 0 L 10 5 z', stroke: LINK_COLOR, fill: LINK_COLOR };

  let graph, paper;
  let $suggest, $review, $explain;
  let lastSelection = { label: null, elementId: null };

  // ---- helpers (safe logging, config, kb access) ----
  const Core = (KB.core || {});
  const log = (ev, data) => { try { Core.log?.(ev, { ...data, mode: getMode(), scenario_id: getScenario(), session_id: getSessionId(), participant_id: getParticipantId() }); } catch (e) {} };
  const getMode = () => Core.getConfig?.()?.experiment?.mode || 'kb';
  const getScenario = () => Core.getConfig?.()?.experiment?.scenario || 'auth';
  const getSessionId = () => (window.__kbSession && window.__kbSession.session_id) || null;
  const getParticipantId = () => (window.__kbSession && window.__kbSession.participant_id) || null;

  // Try to access a KB array; support multiple possible locations.
  function getKBArray() {
    return Core.KB || Core.data || Core.getKB?.() || window.ATTACK_KB || [];
  }

  // ---- node / link creation used by UI actions ----
  function createRect(label, x, y) {
    const Rect = joint.shapes?.standard?.Rectangle || joint.shapes?.basic?.Rect;
    if (!Rect) throw new Error('Rectangle shape unavailable.');
    const r = new Rect();
    r.resize(Math.max(120, Math.min(360, 16 + (label?.length || 4) * 7.5)), 44);
    r.attr({ body: { fill: '#1f2937', stroke: '#6b7280', strokeWidth: 2, magnet: 'passive' }, label: { text: label, fill: '#fff' } });
    r.position(x, y);
    r.addTo(graph);
    return r;
  }

  function makeLink(srcId, tgtId) {
    const Link = joint.shapes?.standard?.Link || joint.dia.Link;
    const l = new Link();
    l.attr({ line: { stroke: LINK_COLOR, strokeWidth: 2, targetMarker: TARGET_MARKER, sourceMarker: { type: 'none' } } });
    l.connector('straight');
    l.source({ id: srcId, anchor: { name: 'center' }, connectionPoint: { name: 'boundary' } });
    l.target({ id: tgtId, anchor: { name: 'center' }, connectionPoint: { name: 'boundary' } });
    l.addTo(graph);
    if (typeof l.removeVertices === 'function') l.removeVertices();
    return l;
  }

  function getSelectedElementByLabel(label) {
    if (!label) return null;
    return graph.getElements().find(el => (el.attr('label/text') || '').toLowerCase() === label.toLowerCase()) || null;
  }

  function positionToTheRightOf(el, dx = 240, dy = 0) {
    const p = el.position();
    return { x: p.x + dx, y: p.y + dy };
  }

  // ---- Suggest engine wrapper (RQ1) ----
  async function getSuggestionsFor(parentLabel) {
    // Prefer the project’s engine if present
    try {
      if (Core.suggestFor) return await Core.suggestFor(parentLabel);
      if (Core.suggest) return await Core.suggest({ parent: parentLabel });
    } catch (e) { console.warn('[KB.ui] suggest engine error', e); }

    // Fallback: look up KB item with matching name/alias; suggest its children; else suggest a few top-level items.
    const kb = getKBArray();
    const labelLc = (parentLabel || '').toLowerCase();
    const hit = kb.find(p =>
      (p.name || '').toLowerCase() === labelLc ||
      (Array.isArray(p.aliases) && p.aliases.map(a => (a || '').toLowerCase()).includes(labelLc))
    );
    let candidates = [];
    if (hit && Array.isArray(hit.children) && hit.children.length) {
      candidates = hit.children.map(ch => ({ id: ch.toLowerCase().replace(/\s+/g, '_'), name: ch, score: 0.75, why: `Child of ${hit.name}` }));
    } else {
      candidates = kb.slice(0, 7).map(p => ({ id: (p.name || '').toLowerCase().replace(/\s+/g, '_'), name: p.name || 'Item', score: p.score || 0.5, why: p.source || 'KB' }));
    }
    return candidates;
  }

  // ---- Prune engine wrapper (RQ2) ----
  async function getPruneFlags() {
    try {
      if (Core.pruneGraph) return await Core.pruneGraph(graph);
      if (Core.prune)      return await Core.prune({ graph });
    } catch (e) { console.warn('[KB.ui] prune engine error', e); }

    // Fallback: flag isolated non-root nodes or duplicate labels
    const els = graph.getElements();
    const flags = [];
    const root = els[0] || null;
    const seen = new Set();
    els.forEach(el => {
      const label = el.attr('label/text') || 'Node';
      const deg = graph.getConnectedLinks(el).length;
      if (el !== root && deg === 0) flags.push({ label, reason: 'Isolated node (no links)', score: 0.8, elementId: el.id });
      const key = (label || '').toLowerCase();
      if (seen.has(key)) flags.push({ label, reason: 'Duplicate label', score: 0.6, elementId: el.id });
      seen.add(key);
    });
    return flags.slice(0, 10);
  }

  // ---- Explain wrapper (RQ3) ----
  function explainFor(label) {
    try {
      if (Core.explain) return Core.explain(label);
    } catch (e) { console.warn('[KB.ui] explain error', e); }

    // Fallback: find in KB and format
    const kb = getKBArray();
    const lc = (label || '').toLowerCase();
    const item = kb.find(p =>
      (p.name || '').toLowerCase() === lc ||
      (Array.isArray(p.aliases) && p.aliases.map(a => (a || '').toLowerCase()).includes(lc))
    );
    const desc = item?.description || `“${label}” is a step or technique in the attack path.`;
    const sev  = item?.severity || item?.impact || 'medium';
    return { label, severity: sev, text: desc };
  }

  // ---- WoZ merge (optional) ----
  async function mergeWoZ(sugList, parentLabel) {
    try {
      if (!KB.woz || !(Core.getConfig?.().woz?.enabled)) return sugList;
      const remote = await KB.woz.fetch?.(getScenario()) || [];
      const dedup = new Map();
      [...sugList, ...remote.filter(r => !parentLabel || r.parent?.toLowerCase() === parentLabel.toLowerCase())]
        .forEach(s => { dedup.set((s.name || '').toLowerCase(), s); });
      return [...dedup.values()];
    } catch (e) {
      console.warn('[KB.ui] WoZ merge failed', e);
      return sugList;
    }
  }

  // ---- renderers ----
  function renderSuggest(parentLabel) {
    if (!$suggest) return;
    $suggest.innerHTML = `<div class="card"><div class="title">Suggestions</div><div class="small">Loading…</div></div>`;
    (async () => {
      let suggestions = await getSuggestionsFor(parentLabel);
      suggestions = await mergeWoZ(suggestions, parentLabel);
      // Log "shown"
      suggestions.forEach((s, idx) => log('suggest_shown', { name: s.name, rank: idx + 1, parent: parentLabel, score: s.score }));

      if (!suggestions.length) {
        $suggest.innerHTML = `<div class="card"><div class="title">Suggestions</div><div class="small">No suggestions for “${parentLabel || 'root'}”.</div></div>`;
        return;
      }

      const list = document.createElement('div');
      list.className = 'stack';
      suggestions.forEach((s) => {
        const row = document.createElement('div');
        row.className = 'card';
        row.innerHTML = `
          <div class="row">
            <div>
              <div class="title">${escapeHtml(s.name || 'Item')}</div>
              <div class="small">${escapeHtml(s.why || '')}</div>
            </div>
            <div style="margin-left:auto;display:flex;gap:6px">
              <button class="btn-accept">Add</button>
            </div>
          </div>`;
        row.querySelector('.btn-accept').onclick = () => acceptSuggestion(s, parentLabel);
        list.appendChild(row);
      });
      $suggest.innerHTML = '';
      $suggest.appendChild(list);
    })();
  }

  function renderPrune() {
    if (!$review) return;
    $review.innerHTML = `<div class="card"><div class="title">Review (Pruning)</div><div class="small">Scanning…</div></div>`;
    (async () => {
      const flags = await getPruneFlags();
      if (!flags.length) {
        $review.innerHTML = `<div class="card"><div class="title">Review (Pruning)</div><div class="small">No pruning candidates yet.</div></div>`;
        return;
      }
      const list = document.createElement('div');
      list.className = 'stack';
      flags.forEach(f => {
        const row = document.createElement('div');
        row.className = 'card';
        row.innerHTML = `
          <div class="row">
            <div>
              <div class="title">${escapeHtml(f.label)}</div>
              <div class="small">${escapeHtml(f.reason || 'Low value')}</div>
            </div>
            <div style="margin-left:auto;display:flex;gap:6px">
              <button class="btn-keep">Keep</button>
              <button class="btn-remove">Remove</button>
            </div>
          </div>`;
        row.querySelector('.btn-keep').onclick = () => { log('prune_keep', { label: f.label, reason: f.reason, score: f.score }); toast(`Kept “${f.label}”`); };
        row.querySelector('.btn-remove').onclick = () => removeNodeById(f.elementId, f.label, f.reason);
        list.appendChild(row);
      });
      $review.innerHTML = '';
      $review.appendChild(list);
    })();
  }

  function renderExplain(label) {
    if (!$explain) return;
    const info = explainFor(label);
    $explain.innerHTML = `
      <div class="card">
        <div class="title">${escapeHtml(info.label || label || 'No node selected')}</div>
        <div class="chip ${severityClass(info.severity)}">${escapeHtml((info.severity || 'medium').toUpperCase())}</div>
        <p style="margin-top:8px">${escapeHtml(info.text || 'Select a node to see details.')}</p>
      </div>`;
    log('explain_view', { label: info.label || label, severity: info.severity });
  }

  function severityClass(s) {
    const v = (s || '').toLowerCase();
    if (v.startsWith('c') || v.includes('crit')) return 'danger';
    if (v.startsWith('h') || v.includes('high')) return 'warn';
    if (v.startsWith('l') || v.includes('low')) return 'ok';
    return 'mid';
  }

  // ---- actions ----
  function acceptSuggestion(s, parentLabel) {
    const els = graph.getElements();
    const parentEl = getSelectedElementByLabel(parentLabel) || els[els.length - 1] || null;
    if (!parentEl && els.length === 0) {
      // Empty canvas → plant as root and attach its immediate children (if any)
      const root = createRect(s.name, 160, 120);
      log('node_added_from_suggest', { name: s.name, parent: null, as: 'root' });
      // Attach children if present in KB
      (findKBChildren(s.name) || []).slice(0, 4).forEach((child, i) => {
        const pos = { x: 160 + 240, y: 120 + i * 70 };
        const childEl = createRect(child, pos.x, pos.y);
        makeLink(root.id, childEl.id);
        log('node_added_from_suggest', { name: child, parent: s.name });
      });
    } else {
      // Normal case → add to the right of parent and link
      const pos = positionToTheRightOf(parentEl, 240, 0);
      const childEl = createRect(s.name, pos.x, pos.y);
      makeLink(parentEl.id, childEl.id);
      log('node_added_from_suggest', { name: s.name, parent: parentLabel });
    }
    toast(`Added “${s.name}”`);
    // Refresh panels (new structure)
    renderPrune();
  }

  function removeNodeById(id, label, reason) {
    const el = id ? graph.getCell(id) : getSelectedElementByLabel(label);
    if (!el) return toast('Node not found');
    const links = graph.getConnectedLinks(el);
    links.forEach(l => l.remove());
    el.remove();
    log('prune_remove', { label, reason });
    toast(`Removed “${label}”`);
    renderPrune();
  }

  function findKBChildren(label) {
    const kb = getKBArray();
    const lc = (label || '').toLowerCase();
    const item = kb.find(p => (p.name || '').toLowerCase() === lc || (p.aliases || []).map(a => (a || '').toLowerCase()).includes(lc));
    return (item && Array.isArray(item.children)) ? item.children : [];
  }

  // ---- UI plumbing ----
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function toast(msg) {
    try {
      const chip = document.getElementById('study-toolbar');
      if (!chip) return;
      chip.dataset.toast = msg;
      chip.classList.add('pulse');
      setTimeout(() => chip.classList.remove('pulse'), 500);
    } catch {}
  }

  function wireTabsOnce() {
    const tabs = document.querySelectorAll('#kb-panel .tabs [data-tab]');
    const bodies = {
      suggest: document.getElementById('tab-suggest'),
      review:  document.getElementById('tab-review'),
      explain: document.getElementById('tab-explain'),
    };
    tabs.forEach(btn => {
      btn.addEventListener('click', () => {
        tabs.forEach(b => b.classList.remove('active'));
        Object.values(bodies).forEach(el => el.classList.add('hidden'));
        btn.classList.add('active');
        const id = btn.dataset.tab;
        bodies[id]?.classList.remove('hidden');
      }, { once: true });
    });
  }

  // ---- public mount ----
  function mount(g, p) {
    graph = g; paper = p;
    $suggest = document.getElementById('tab-suggest');
    $review  = document.getElementById('tab-review');
    $explain = document.getElementById('tab-explain');

    wireTabsOnce();

    // First render
    renderSuggest(null);
    renderPrune();
    renderExplain(null);

    // Update when selection changes (fired by app.js)
    document.addEventListener('kb:selection', (ev) => {
      const parent = ev?.detail?.parent || null;
      lastSelection.label = parent;
      renderSuggest(parent);
      renderPrune();
      renderExplain(parent);
    });

    // Also update Explain when the graph changes (labels/links)
    graph.on('change:attrs add remove', _.debounce(() => {
      if (lastSelection.label) renderExplain(lastSelection.label);
      renderPrune();
    }, 200));
  }

  return { mount };
})();
