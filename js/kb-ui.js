// js/kb-ui.js — Suggest / Review (Prune) / Explain with RQ1+RQ2 instrumentation:
// - Logs exposure of "Show more" suggestions (RQ1 Coverage@7/MRR)
// - Cooldown: items the participant KEPT are not re-flagged again (RQ2 precision)
// - Gate explanations preserved

(function () {
  if (!window.KB) window.KB = {};
  const UI = {};
  KB.ui = UI;

  let G = null, P = null;
  let CURRENT_PARENT = null;

  // RQ2 cooldown for prune flags the user kept
  const KEPT = new Set(); // stores lowercased labels the user marked "Keep"



// Track and apply a "muted" (greyed) style for flagged nodes — view class only (no model changes)
const MUTED = new Set();
let PRUNE_RENDER_GEN = 0;

function isAssistOn() {
  // Start Assist sets 'assistant-on' on <body>; gate greying by this
  return !!document.body && document.body.classList.contains('assistant-on');
}

function setNodeMutedById(id, on) {
  try {
    const el = G?.getCell?.(id);
    if (!el) return;
    const view = P?.findViewByModel?.(el);
    if (!view || !view.el) return;
    view.el.classList.toggle('kb-muted', !!on);
  } catch {}
}



  UI.mount = function mount(graph, paper) {
    G = graph; P = paper;

    const panel = document.getElementById('kb-panel');
    const tabs = panel?.querySelector('.tabs');
    tabs?.addEventListener('click', (e) => {
      if (e.target.tagName !== 'BUTTON') return;
      const name = e.target.getAttribute('data-tab');
      panel.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b === e.target));
      panel.querySelectorAll('.tab-body').forEach(div => div.classList.add('hidden'));
      document.getElementById(`tab-${name}`)?.classList.remove('hidden');

      if (name === 'suggest') renderSuggest(true);
      if (name === 'review')  renderPrune(true);
      if (name === 'explain') renderExplain();
    });

    document.addEventListener('kb:selection', (ev) => {
      CURRENT_PARENT = (ev.detail && ev.detail.parent) || null;
      renderSuggest(true);
      renderExplain();
    });

    // initial paint
    renderSuggest(false); renderPrune(false); renderExplain();
    // recalc prune on graph changes
    // Recalc prune on *any* meaningful graph mutation
const throttled = (window._?.throttle ? _.throttle(() => renderPrune(true), 150) : () => renderPrune(true));
G.on('add remove change', throttled);
// Also refresh after a full import/reset (e.g., Load)
G.on('reset', () => renderPrune(true));
  };

  function scenarioId() { return (window.__kbSession && window.__kbSession.scenario_id) || null; }

  /* ---------------- Suggest ---------------- */
  function renderSuggest(emitLog) {
    const box = document.getElementById('tab-suggest');
    if (!box) return;
    box.innerHTML = '';

    const scen = scenarioId();
    const { top, more, parentLabel } = KB.core.suggest({ graph: G, parentLabel: CURRENT_PARENT, scenarioId: scen });

    const hdr = document.createElement('div');
    hdr.className = 'card';
    hdr.innerHTML = `<div class="title">Suggestions ${parentLabel ? `for “${escapeHtml(parentLabel)}”` : '(root)'}</div>`;
    box.appendChild(hdr);

if (!top.length && !more.length) {
  const empty = document.createElement('div');
  empty.className = 'small';
  empty.textContent = 'No suggestions right now.';
  hdr.appendChild(empty);

  (async () => {
    try {
      if (!window.KB?.sem || !CURRENT_PARENT) return;
      const ok = await KB.sem.ready?.();
      if (!ok) return;

      const matches = await KB.sem.topK(CURRENT_PARENT, 3);
      if (!matches || !matches.length) return;

      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `<div class="title">Semantic suggestions</div>`;
      box.appendChild(card);

      const list = document.createElement('div');
      list.className = 'list';

      matches.forEach((m, i) => {
        const name = (KB.core.explain?.(m.id)?.title) || m.id;
        const sug = {
          id: m.id,
          name,
          source: 'semantic',
          reason: `Similar to “${CURRENT_PARENT}”`,
          score: m.score
        };
        list.appendChild(suggestionRow(sug, i + 1));
        try { if (emitLog) KB.core.log('suggest_semantic_shown', { id: m.id, name, parent: CURRENT_PARENT, score: m.score }); } catch {}
      });

      box.appendChild(list);
    } catch (e) {
      console.warn('[suggest:semantic]', e);
    }
  })();

  return;
}



    const list = document.createElement('div'); list.className = 'list';
    top.forEach((sug, i) => {
      list.appendChild(suggestionRow(sug, i+1));
      if (emitLog) try { KB.core.log('suggest_shown', { id: sug.id, name: sug.name, parent: parentLabel || null, rank: i+1, score: Number(sug.score?.toFixed?.(3) || sug.score), badge: sug.badge || null }); } catch {}
    });
    box.appendChild(list);

    if (more.length) {
      const moreWrap = document.createElement('details');
      const sum = document.createElement('summary');
      sum.textContent = `Show ${more.length} more (includes low-confidence or possibly redundant items)`;
      moreWrap.appendChild(sum);
      const moreList = document.createElement('div');
      more.forEach((sug, i) => moreList.appendChild(suggestionRow(sug, top.length + i + 1)));
      moreWrap.appendChild(moreList);

      // RQ1: when the user expands "Show more", log exposure for Coverage@7/MRR
      moreWrap.addEventListener('toggle', () => {
        if (moreWrap.open) {
          more.forEach((sug, i) => {
            try { KB.core.log('suggest_shown', {
              id: sug.id, name: sug.name, parent: parentLabel || null,
              rank: top.length + i + 1, score: Number(sug.score?.toFixed?.(3) || sug.score), badge: sug.badge || null
            }); } catch {}
          });
        }
      });

      box.appendChild(moreWrap);
    }
  }

    function suggestionRow(sug, rank) {
    const row = document.createElement('div'); 
    row.className = 'row';

    const left = document.createElement('div'); 
    left.style.flex = '1';

    const name = document.createElement('div');
    name.innerHTML = `<strong>${escapeHtml(sug.name)}</strong> <span class="small muted">#${rank} · ${sug.source}${sug.badge ? ' · <span class="tag">must-have</span>' : ''}</span>`;

    const why  = document.createElement('div'); 
    why.className = 'small'; 
    why.textContent = sug.reason;

    left.appendChild(name); 
    left.appendChild(why);

    // ---- controls: Explain + Add ----
    const controls = document.createElement('div');
    controls.style.display = 'flex'; 
    controls.style.gap = '8px';

    const btnExplain = document.createElement('button');
    btnExplain.textContent = 'Explain';
    btnExplain.title = 'Preview what this means before adding';
    btnExplain.onclick = () => toggleSuggestExplanation(row, sug);

    const btnAdd = document.createElement('button');
    btnAdd.textContent = 'Add';
    btnAdd.onclick = () => {
      addNodeToGraph(sug.name);
      try { KB.core.log('node_added_from_suggest', { id: sug.id, name: sug.name, source: sug.source, rank }); } catch {}
      renderSuggest(false); 
      renderPrune(false);
    };

    controls.appendChild(btnExplain);
    controls.appendChild(btnAdd);

    // inline explanation panel (hidden by default)
    const expl = document.createElement('div');
    expl.className = 'small';
    expl.style.display = 'none';
    expl.style.marginTop = '6px';
    expl.style.padding = '8px';
    expl.style.border = '1px solid #2e3a46';
    expl.style.borderRadius = '6px';
    expl.style.background = '#0e1620';
    expl.setAttribute('data-explain-pane', '1');

    left.appendChild(controls);
    left.appendChild(expl);

    row.appendChild(left);
    return row;
  }

// toggles inline explanation for a suggestion row (robust: resolve → entry.description|comms|why)
function toggleSuggestExplanation(rowEl, sug) {
  const pane = rowEl.querySelector('[data-explain-pane]');
  if (!pane) return;

  // If already loaded once, just toggle visibility
  if (pane.dataset.loaded === '1') {
    pane.style.display = (pane.style.display === 'none') ? '' : 'none';
    return;
  }

  // Prefer resolving by NAME (more canonical), then fallback to ID
  let res = KB.core.resolve?.(sug.name);
  if (!res?.entry && sug.id) res = KB.core.resolve?.(sug.id);

  const e = res?.entry || null;
  const text =
    (e?.description && String(e.description).trim()) ||
    (e?.comms && String(e.comms).trim()) ||
    (e?.why && String(e.why).trim()) ||
    'No explanation available for this suggestion.';
  const sev  = (e?.severity ? String(e.severity).toLowerCase() : 'unknown');

  pane.textContent = `${text} · severity: ${sev}`;
  pane.dataset.loaded = '1';
  pane.style.display = '';

  try { KB.core.log('suggest_explain_preview', { id: e?.id || res?.id || sug.id || null, name: e?.name || sug.name }); } catch {}

  // Debug hint if still empty, so you can see what failed
  if (!e) console.warn('[suggest:explain] No KB entry resolved for', sug);
}



  function addNodeToGraph(label) {
    const Rect = joint.shapes?.standard?.Rectangle || joint.shapes?.basic?.Rect;
    if (!Rect) return alert('Rectangle shape missing (JointJS).');
    const el = new Rect();
    el.resize(200, 44);
    el.attr({
      body:  { fill: '#1f2937', stroke: '#6b7280', strokeWidth: 2, magnet: 'passive' },
      label: { text: label, fill: '#fff' }
    });
    let x = 120, y = 120;
    try {
      if (CURRENT_PARENT) {
        const node = (G.getElements() || []).find(n => (n.attr?.('label/text')||'') === CURRENT_PARENT);
        if (node) { const p = node.position(); x = p.x + 240; y = p.y; }
      }
    } catch {}
    el.position(x, y);
    el.set('ports', { groups: {
      left:   { position: { name: 'left' },   attrs: { circle: { r: 5, magnet: true, fill: '#60a5fa', stroke: '#0b0f14' } } },
      right:  { position: { name: 'right' },  attrs: { circle: { r: 5, magnet: true, fill: '#60a5fa', stroke: '#0b0f14' } } },
      top:    { position: { name: 'top' },    attrs: { circle: { r: 5, magnet: true, fill: '#60a5fa', stroke: '#0b0f14' } } },
      bottom: { position: { name: 'bottom' }, attrs: { circle: { r: 5, magnet: true, fill: '#60a5fa', stroke: '#0b0f14' } } }
    }, items: [{group:'left'},{group:'right'},{group:'top'},{group:'bottom'}]});
    el.addTo(G);
    window.autoSizeElement?.(el);
  }

/* ---------------- Prune ---------------- */
function renderPrune(emitLog) {
  const gen = ++PRUNE_RENDER_GEN;

  const box = document.getElementById('tab-review');
  if (!box) return;
  box.innerHTML = '';

  const scen = scenarioId();
  // Ask core for many, we’ll page locally (so more can bubble up immediately).
  const flagsAll = KB.core.prune({ graph: G, scenarioId: scen, maxVisible: 999 });

  // RQ2 cooldown: suppress items the participant already kept
  const flags = flagsAll.filter(f => !KEPT.has((f.label || '').toLowerCase()));

  const hdr = document.createElement('div'); hdr.className = 'card';
  hdr.innerHTML = `<div class="title">Review (prune candidates)</div>`;
  box.appendChild(hdr);

// --- Grey-out handling (only AFTER Start Assist): clear then apply
MUTED.forEach((id) => setNodeMutedById(id, false));
MUTED.clear();

if (isAssistOn()) {
  for (const f of flags) {
    if (f.elementId) {
      setNodeMutedById(f.elementId, true);
      MUTED.add(f.elementId);
    }
  }
}



  if (!flags.length) {
    const empty = document.createElement('div'); empty.className = 'small';
    empty.textContent = 'No pruning suggestions right now.';
    hdr.appendChild(empty);
    return;
  }

  const VISIBLE = 5;
  const top  = flags.slice(0, VISIBLE);
  const more = flags.slice(VISIBLE);

  const makeRow = (flag) => {
    if (emitLog) try {
      KB.core.log('prune_flag_shown', {
        label: flag.label,
        reason: flag.reason,
        score: Number(flag.score?.toFixed?.(3) || flag.score)
      });
    } catch {}

    const row  = document.createElement('div'); row.className = 'row';
    const left = document.createElement('div'); left.style.flex = '1';
    const title = document.createElement('div'); title.innerHTML = `<strong>${escapeHtml(flag.label)}</strong>`;
    const why   = document.createElement('div');  why.className = 'small'; why.textContent = flag.reason;
    left.appendChild(title); left.appendChild(why);

    const keep = document.createElement('button'); keep.textContent = 'Keep';
    keep.onclick = () => {
      KEPT.add((flag.label || '').toLowerCase());           // cooldown this label
      try { KB.core.log('prune_keep', { label: flag.label }); } catch {}
      renderPrune(false);                                   // reveal next candidates
    };

    const del = document.createElement('button'); del.textContent = 'Remove'; del.style.marginLeft = '6px';
    del.onclick = () => {
      const el = G.getCell(flag.elementId);
      if (!el) return;
      try { (G.getConnectedLinks(el) || []).forEach(l => l.remove()); } catch {}
      el.remove();
      try { KB.core.log('prune_remove', { label: flag.label }); } catch {}
      renderPrune(false);                                   // list updates immediately
      renderSuggest(false);                                 // suggestions may change
    };

    const btns = document.createElement('div'); btns.appendChild(keep); btns.appendChild(del);
    row.appendChild(left); row.appendChild(btns);
    return row;
  };

  top.forEach(f => box.appendChild(makeRow(f)));

  if (more.length) {
    const moreWrap = document.createElement('details');
    const sum = document.createElement('summary');
    sum.textContent = `Show ${more.length} more prune candidates`;
    moreWrap.appendChild(sum);

    const moreList = document.createElement('div');
    more.forEach(f => moreList.appendChild(makeRow(f)));
    moreWrap.appendChild(moreList);

    box.appendChild(moreWrap);
  }

  // ---- Semantic duplicates (asynchronous, non-blocking) ----
(async () => {
  try {
    if (!window.KB?.sem) return;
    const ready = await KB.sem.ready?.();
    if (!ready) return;

    // Collect non-gate labels from the graph
    const nodes = (G.getElements?.() || []).filter(n => !n.get?.('gate'));
    const labels = nodes.map(n => ({ id: n.id, label: n.attr?.('label/text') || '' }))
                        .filter(x => x.label && !KB.core.isScenarioGoal?.(x.label));

    // Map each label to its best KB id (if above threshold)
    const groups = new Map(); // kbId -> [{nodeId,label,score}]
    for (const item of labels) {
      const m = await KB.sem.best(item.label, 1);
      if (!m || !m.id || typeof m.score !== 'number') continue;
      const t = (KB.core.getConfig?.().matching?.semantic?.threshold ?? 0.60);
      if (m.score < t) continue;
      if (!groups.has(m.id)) groups.set(m.id, []);
      groups.get(m.id).push({ nodeId: item.id, label: item.label, score: m.score });
    }

    // For any KB id mapped by 2+ different labels, flag as duplicates
    const dupSets = [...groups.values()].filter(arr => arr.length >= 2);
    if (!dupSets.length) return;

    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<div class="title">Possible duplicates (semantic)</div>`;
    box.appendChild(card);

    const list = document.createElement('div');
    list.className = 'list';

    dupSets.forEach(set => {
      // Keep the highest score as the “original” suggestion to keep; the rest are removable
      const sorted = set.sort((a, b) => b.score - a.score);
      const keep = sorted[0];
      const rest = sorted.slice(1);

      rest.forEach(d => {
        const row = document.createElement('div'); row.className = 'row';
        const left = document.createElement('div'); left.style.flex = '1';

        const title = document.createElement('div');
        title.innerHTML = `<strong>${escapeHtml(d.label)}</strong> <span class="small muted">(~${Math.round(d.score * 100)}% similar)</span>`;

        const why = document.createElement('div'); why.className = 'small';
        why.textContent = `Looks like a duplicate of “${keep.label}”.`;
        left.appendChild(title); left.appendChild(why);

        const btns = document.createElement('div');

        const keepBtn = document.createElement('button');
        keepBtn.textContent = 'Keep';
        keepBtn.onclick = () => {
          try { KB.core.log('prune_keep_semantic_dup', { label: d.label, keptAgainst: keep.label }); } catch {}
          // cooldown this label so it won't repeat
          KEPT.add((d.label || '').toLowerCase());
          renderPrune(false);
        };

        const delBtn = document.createElement('button');
        delBtn.textContent = 'Remove';
        delBtn.style.marginLeft = '6px';
        delBtn.onclick = () => {
          const el = G.getCell(d.nodeId);
          if (!el) return;
          try { (G.getConnectedLinks(el) || []).forEach(l => l.remove()); } catch {}
          el.remove();
          try { KB.core.log('prune_remove_semantic_dup', { label: d.label, removedAgainst: keep.label }); } catch {}
          renderPrune(false);
          renderSuggest(false);
        };

        btns.appendChild(keepBtn); btns.appendChild(delBtn);
        row.appendChild(left); row.appendChild(btns);
        list.appendChild(row);
      });
    });

    box.appendChild(list);
  } catch (e) {
    console.warn('[review:semantic-duplicates]', e);
  }
})();

}


  // map raw severity -> human label + colored class
function severityMeta(raw) {
  const s = String(raw || '').toLowerCase();
  if (s === 'high')   return { cls: 'sev sev-high',   text: 'High severity' };
  if (s === 'medium') return { cls: 'sev sev-medium', text: 'Medium severity' };
  if (s === 'low')    return { cls: 'sev sev-low',    text: 'Low severity' };
  return { cls: 'sev sev-unknown', text: 'Severity unknown' };
}


  /* ---------------- Explain ---------------- */
  function renderExplain() {
    const box = document.getElementById('tab-explain');
    if (!box) return;
    box.innerHTML = '';

    const header = document.createElement('div'); header.className = 'card';
    header.innerHTML = `<div class="title">Explain</div>`;
    box.appendChild(header);

    const label = CURRENT_PARENT;
    if (!label) {
      const small = document.createElement('div'); small.className = 'small';
      small.textContent = 'Select a node or gate to see a plain-English explanation.';
      header.appendChild(small);
      return;
    }

    // Gate? show semantics + children
    let gateKind = null, selectedEl = null;
    try { selectedEl = (G.getElements?.() || []).find(n => (n.attr?.('label/text')||'') === label || n.id === label); } catch {}
    if (selectedEl && selectedEl.get?.('gate')) gateKind = selectedEl.get('gate');

    if (gateKind) {
      const card = document.createElement('div'); card.className = 'card';
      const kids = (G.getNeighbors?.(selectedEl) || [])
        .filter(c => c.isElement?.())
        .map(c => c.attr?.('label/text') || 'node')
        .slice(0, 6);
      card.innerHTML = `
        <div class="title">${escapeHtml(gateKind)} gate</div>
        <div class="body">
          ${gateKind === 'AND'
            ? 'All of the following steps must happen for this branch to succeed.'
            : 'Any one of the following steps is sufficient for this branch to succeed.'}
          ${kids.length ? `<div class="small muted" style="margin-top:6px">Children: ${kids.map(escapeHtml).join(', ')}</div>` : ''}
        </div>
      `;
      box.appendChild(card);
      try { KB.core.log('explain_view', { gate: gateKind }); } catch {}
      return;
    }

// Leaf explanation (with colored severity badge)
const raw = KB.core.explain?.(label) || {};
const title = raw.title || raw.name || label;
const sm    = severityMeta(raw.severity); // <-- use your helper
const body  = raw.summary || raw.description || 'No explanation available for this item.';
const why   = raw.why;

const card = document.createElement('div'); 
card.className = 'card';
card.innerHTML = `
  <div class="title">
    ${escapeHtml(title)}
    <span class="${sm.cls}">${escapeHtml(sm.text)}</span>
  </div>
  <div class="body">${escapeHtml(body)}</div>
  ${why ? `<div class="small muted">Why shown: ${escapeHtml(why)}</div>` : ''}
`;
box.appendChild(card);
try { KB.core.log('explain_view', { name: title }); } catch {}

// --- semantic fallback: if the main explain had nothing useful, show closest known techniques
(async () => {
  const noUsefulText = (!raw.summary && !raw.description) || /No explanation available/i.test(body);
  if (!noUsefulText) return;
  if (!window.KB?.sem) return;

  try {
    const ok = await KB.sem.ready?.();
    if (!ok) return;

    const alts = await KB.sem.topK(label, 3);
    if (!alts || !alts.length) return;

    const altCard = document.createElement('div');
    altCard.className = 'card';
    const items = alts.map(a => {
      const m = KB.core.explain?.(a.id) || {};
      const name = m.title || m.name || a.id;
      const pct  = Math.round((a.score || 0) * 100);
      return `<li>${escapeHtml(name)} <span class="small muted">(${pct}% similar)</span></li>`;
    }).join('');

    altCard.innerHTML = `
      <div class="title">Closest known technique</div>
      <div class="body">
        We couldn’t find an exact match for “${escapeHtml(label)}”. Did you mean:
        <ul style="margin-top:6px; padding-left:18px">${items}</ul>
      </div>
    `;
    box.appendChild(altCard);
    try { KB.core.log('explain_semantic_fallback', { label, matches: alts.map(a => a.id) }); } catch {}
  } catch (e) {
    console.warn('[explain:fallback]', e);
  }
})();




  }

  /* ---------------- helpers ---------------- */
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;'}[c]));
  }

  
  
})();
