
// js/app.js — ports drag-to-link, one small arrowhead at TARGET, center/boundary anchoring,
// pan on blank, add/rename/delete/clear/save/load, session start dialog.
// RQ1/RQ2 instrumentation: logs manual actions (create/link/rename/delete).

document.addEventListener('DOMContentLoaded', () => {
  init().catch(err => { console.error('[FATAL]', err); showFatal(err); });
});



const Session = {
  get() { return window.__kbSession || null; },
  set(s) { window.__kbSession = s; },
};

async function init() {
  await ensureLibs();
  await safeLoadConfigAndKB();
  const { graph, paper } = makeCanvas();
  wireUI(graph, paper);
  ensureSessionStart();
}

// --- text measurement + autosize ---
(function(){
  const measureCtx = document.createElement('canvas').getContext('2d');
  // match your SVG label style (tweak if you changed fonts/sizes)
  const LABEL_FONT = '14px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';

  function measureTextWidth(txt) {
    try { measureCtx.font = LABEL_FONT; } catch {}
    return Math.ceil(measureCtx.measureText(String(txt || '')).width);
  }

  window.autoSizeElement = function autoSizeElement(el) {
    if (!el || typeof el.attr !== 'function' || typeof el.resize !== 'function') return;
    const label = el.attr('label/text') || '';
    const size  = (typeof el.size === 'function' ? el.size() : el.get('size')) || { width: 200, height: 44 };
    const minW  = 160;           // minimum box width
    const pad   = 24;            // horizontal padding inside the rect
    const needed = measureTextWidth(label) + pad * 2;
    const newW = Math.max(minW, needed);
    el.resize(newW, size.height);
  };
})();


/* -------------------- lib loader -------------------- */
async function ensureLibs() {
  await ensureScript(() => !!window.jQuery,  'https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js', 'jquery');
  await ensureScript(() => !!window._,       'https://cdnjs.cloudflare.com/ajax/libs/lodash.js/4.17.21/lodash.min.js', 'lodash');
  await ensureScript(() => !!window.Backbone,'https://cdnjs.cloudflare.com/ajax/libs/backbone.js/1.5.0/backbone-min.js', 'backbone');
  await ensureScript(() => !!window.joint && !!window.joint.dia,
                     'https://cdnjs.cloudflare.com/ajax/libs/jointjs/3.7.7/joint.min.js', 'jointjs');
}
function ensureScript(testFn, url, name) {
  if (testFn()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url; s.async = false;
    s.onload = () => testFn() ? resolve() : reject(new Error(`Loaded ${name} but test failed`));
    s.onerror = () => reject(new Error(`Failed to load ${name} (${url})`));
    document.head.appendChild(s);
  });
}
async function safeLoadConfigAndKB() {
  try { await KB.core.loadConfig(); } catch (e) { console.warn('[INIT] config load failed:', e); }
  try { await KB.core.loadKB(); } catch (e) { console.warn('[INIT] KB load failed:', e); }
}

/* -------------------- visuals -------------------- */
const LINK_COLOR = '#9aa0a6';
const TARGET_MARKER = { type: 'path', d: 'M 10 -5 L 0 0 L 10 5 z', stroke: LINK_COLOR, fill: LINK_COLOR };

// --- text measurement + autosize (boxes grow to fit label) ---
(function () {
  const measureCtx = document.createElement('canvas').getContext('2d');
  const LABEL_FONT = '14px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';

  function measureTextWidth(txt) {
    try { measureCtx.font = LABEL_FONT; } catch {}
    return Math.ceil(measureCtx.measureText(String(txt || '')).width);
  }

  window.autoSizeElement = function autoSizeElement(el) {
    if (!el || typeof el.attr !== 'function' || typeof el.resize !== 'function') return;
    const label = el.attr('label/text') || '';
    const size  = (typeof el.size === 'function' ? el.size() : el.get('size')) || { width: 200, height: 44 };
    const minW  = 160;   // min box width
    const pad   = 24;    // left+right text padding inside the rect
    const needed = measureTextWidth(label) + pad * 2;
    const newW = Math.max(minW, needed);
    el.resize(newW, size.height);
  };
})();


/* -------------------- canvas -------------------- */
function makeCanvas() {
  const pc = document.getElementById('paper-container');
  const rect = pc.getBoundingClientRect();
  const width  = Math.max(600, rect.width  || (window.innerWidth - 360));
  const height = Math.max(400, rect.height || (window.innerHeight -  48));

  const ns = joint.shapes;
  const graph = new joint.dia.Graph({}, { cellNamespace: ns });

  const paper = new joint.dia.Paper({
    el: pc,
    model: graph,
    width, height,
    gridSize: 15,
    drawGrid: true,
    interactive: { linkMove: false },
    cellViewNamespace: ns,
    defaultLink: new joint.shapes.standard.Link({
      attrs: { line: { stroke: LINK_COLOR, strokeWidth: 2, targetMarker: TARGET_MARKER, sourceMarker: { type: 'none' } } },
      router: { name: 'normal' },
      connector: { name: 'straight' }
    }),
    linkPinning: false,
    snapLinks: { radius: 30 },
    validateMagnet: (cv, magnet) => magnet && magnet.getAttribute('magnet') !== 'passive',
    validateConnection: (sv, sm, tv, tm) => sv && tv && sv !== tv && !!sm && !!tm
  });

  window.addEventListener('resize', () => {
    const r = pc.getBoundingClientRect();
    paper.setDimensions(r.width || width, r.height || height);
  });

  window.graph = graph; window.paper = paper; window.joint = joint;
  document.dispatchEvent(new CustomEvent('kb:canvas:ready', { detail: { graph, paper } }));
  return { graph, paper };
}

/* -------------------- UI & editing -------------------- */
function wireUI(graph, paper) {
  try { KB.ui.mount(graph, paper); } catch {}

  const RectClass   = joint.shapes?.standard?.Rectangle || joint.shapes?.basic?.Rect;
  const CircleClass = joint.shapes?.standard?.Circle    || joint.shapes?.basic?.Circle;

  // Simple logger passthrough for RQ1/RQ2
  const log = (ev, data) => { try { KB?.core?.log?.(ev, data || {}); } catch {} };

  // ---- Ports on all 4 sides ----
  const PORT_GROUPS = {
    left:   { position: { name: 'left'   }, attrs: { circle: { r: 5, magnet: true, fill: '#60a5fa', stroke: '#0b0f14' } } },
    right:  { position: { name: 'right'  }, attrs: { circle: { r: 5, magnet: true, fill: '#60a5fa', stroke: '#0b0f14' } } },
    top:    { position: { name: 'top'    }, attrs: { circle: { r: 5, magnet: true, fill: '#60a5fa', stroke: '#0b0f14' } } },
    bottom: { position: { name: 'bottom' }, attrs: { circle: { r: 5, magnet: true, fill: '#60a5fa', stroke: '#0b0f14' } } }
  };
  function addPorts(el) {
    el.set('ports', { groups: PORT_GROUPS, items: [] });
    el.addPorts([{ group: 'left' }, { group: 'right' }, { group: 'top' }, { group: 'bottom' }]);
  }

  function createRect(label = 'Node', x = 160, y = 120) {
    if (!RectClass) throw new Error('Rectangle shape unavailable.');
    const rect = new RectClass();
    rect.resize(200, 44);
    rect.attr({
      body:  { fill: '#1f2937', stroke: '#6b7280', strokeWidth: 2, magnet: 'passive' },
      label: { text: label, fill: '#fff' }
    });
    rect.position(x, y);
    addPorts(rect);
    rect.addTo(graph);
    window.autoSizeElement(rect);
    log('node_created', { id: rect.id, label });
    return rect;
  }
  function createGate(kind, x = 180, y = 160) {
    if (!CircleClass) throw new Error('Circle shape unavailable.');
    const gate = new CircleClass();
    gate.resize(38, 38);
    gate.attr({
      body:  { fill: '#162033', stroke: '#60a5fa', strokeWidth: 2, magnet: 'passive' },
      label: { text: kind, fill: '#e5e7eb', fontSize: 12, fontWeight: 'bold' }
    });
    gate.set('gate', kind);
    gate.position(x, y);
    addPorts(gate);
    gate.addTo(graph);
    log('gate_created', { id: gate.id, kind });
    return gate;
  }

  

  // selection
  let selectedElement = null;
  let selectedLink = null;

  // panning on blank
  const pc = document.getElementById('paper-container');
  let isPanning = false;
  let panStart = { x: 0, y: 0 };
  let panOrigin = { x: 0, y: 0 };

  const $ = (id) => document.getElementById(id);
  const btnNew   = $('btn-new');
  const btnAdd   = $('btn-add');
  const btnAnd   = $('btn-and');
  const btnOr    = $('btn-or');
  const btnRen   = $('btn-rename');
  const btnDel   = $('btn-delete');
  const btnClear = $('btn-clear');
  const btnSave  = $('btn-save');
  const btnLoad  = $('btn-load');

  function updateSelLabel() {
    const label = selectedElement?.attr?.('label/text') || (selectedLink ? 'link' : '');
    $('sel-label').textContent = label ? `Selected: ${label}` : 'No selection';
  }

  // ----- element interactions -----
  paper.on('element:pointerdown', (view) => {
    selectedElement = view.model; selectedLink = null;
    try { KB.ui.refreshSelection(view); } catch {}
    document.dispatchEvent(new CustomEvent('kb:selection', { detail: { parent: selectedElement.attr('label/text') || '' } }));
    updateSelLabel();
  });
  paper.on('element:pointerdblclick', (view) => {
    selectedElement = view.model;
    const old = selectedElement.attr('label/text') || '';
    const nv = prompt('New name:', old);
    if (nv && nv.trim()) {
      selectedElement.attr('label/text', nv.trim());
      window.autoSizeElement?.(selectedElement);
      log('node_renamed', { id: selectedElement.id, from: old, to: nv.trim() });
      try { KB.ui.refreshSelection({ model: selectedElement }); } catch {}
      updateSelLabel();
    }
  });

  // ----- link created: center anchors, boundary connection, single arrow at TARGET -----
  paper.on('link:connect', (linkView) => {
    const m = linkView.model;
    const srcEl = m.getSourceElement();
    const tgtEl = m.getTargetElement();

    if (srcEl) m.set('source', { id: srcEl.id, anchor: { name: 'center' }, connectionPoint: { name: 'boundary' } });
    if (tgtEl) m.set('target', { id: tgtEl.id, anchor: { name: 'center' }, connectionPoint: { name: 'boundary' } });

    m.attr('line/targetMarker', TARGET_MARKER);
    m.attr('line/sourceMarker', { type: 'none' });

    if (typeof m.removeVertices === 'function') m.removeVertices();
    if (typeof linkView.update === 'function') linkView.update();
    if (typeof m.toFront === 'function') m.toFront();

    // RQ1/RQ2: log link creation (for parsimony/structure diffs)
    const sLabel = srcEl?.attr?.('label/text') || (srcEl?.get?.('gate') ? `${srcEl.get('gate')} gate` : 'node');
    const tLabel = tgtEl?.attr?.('label/text') || (tgtEl?.get?.('gate') ? `${tgtEl.get('gate')} gate` : 'node');
    log('link_created', { source: sLabel, target: tLabel });
  });

  // select link
  paper.on('link:pointerdown', (view) => { selectedLink = view.model; selectedElement = null; updateSelLabel(); });


  enablePanZoom(paper);
enableAutoResize(paper, graph);

  // ----- pan on blank drag -----
  paper.on('blank:pointerdown', (evt, x, y) => {
    selectedElement = null; selectedLink = null;
    try { KB.ui.refreshSelection(null); } catch {}
    updateSelLabel();
    isPanning = true; panStart = { x, y }; pc.classList.add('grabbing');
  });
  paper.on('blank:pointermove', (evt, x, y) => {
    if (!isPanning) return;
    const dx = x - panStart.x;
    const dy = y - panStart.y;
    paper.translate(panOrigin.x + dx, panOrigin.y + dy);
  });
  paper.on('blank:pointerup', () => {
    if (!isPanning) return;
    const t = paper.translate(); panOrigin = { x: t.tx || 0, y: t.ty || 0 };
    isPanning = false; pc.classList.remove('grabbing');
  });

  // ----- toolbar -----
  btnNew.addEventListener('click', () => {
    const root = createRect('Goal', 160, 120);
    selectedElement = root; selectedLink = null; updateSelLabel();
  });

  btnAdd.addEventListener('click', () => {
    const pos = selectedElement ? selectedElement.position() : { x: 160, y: 120 };
    const node = createRect('Node', pos.x + 240, pos.y);
    selectedElement = node; selectedLink = null; updateSelLabel();
  });

  btnAnd.addEventListener('click', () => {
    const pos = selectedElement ? selectedElement.position() : { x: 180, y: 160 };
    const gate = createGate('AND', pos.x + 200, pos.y + 20);
    selectedElement = gate; selectedLink = null; updateSelLabel();
  });

  btnOr.addEventListener('click', () => {
    const pos = selectedElement ? selectedElement.position() : { x: 180, y: 160 };
    const gate = createGate('OR', pos.x + 200, pos.y + 20);
    selectedElement = gate; selectedLink = null; updateSelLabel();
  });

  btnRen.addEventListener('click', () => {
    if (!selectedElement) return alert('Select a node to rename.');
    const old = selectedElement.attr('label/text') || '';
    const nv = prompt('New name:', old);
    if (nv && nv.trim()) {
      selectedElement.attr('label/text', nv.trim());
      window.autoSizeElement?.(selectedElement);
      log('node_renamed', { id: selectedElement.id, from: old, to: nv.trim() });
      try { KB.ui.refreshSelection({ model: selectedElement }); } catch {}
      updateSelLabel();
    }
  });

  btnDel.addEventListener('click', () => {
    if (selectedElement) {
      const label = selectedElement.attr?.('label/text') || (selectedElement.get?.('gate') ? `${selectedElement.get('gate')} gate` : 'node');
      const links = graph.getConnectedLinks(selectedElement);
      links.forEach(l => l.remove());
      selectedElement.remove();
      log('node_deleted', { label });
      selectedElement = null; updateSelLabel(); try { KB.ui.refreshSelection(null); } catch {}
    } else if (selectedLink) {
      selectedLink.remove(); log('link_deleted', {});
      selectedLink = null; updateSelLabel();
    } else {
      alert('Select a node or link to delete.');
    }
  });

  btnClear.addEventListener('click', () => {
    if (!confirm('Clear the entire canvas? This cannot be undone.')) return;
    graph.clear();
    selectedElement = null; selectedLink = null; updateSelLabel(); try { KB.ui.refreshSelection(null); } catch {}
    panOrigin = { x: 0, y: 0 }; paper.translate(0, 0);
  });

  btnSave.addEventListener('click', () => {
    const json = graph.toJSON();
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
    Utils.saveFile(`tree_${new Date().toISOString().replace(/[:.]/g,'-')}.json`, blob);
  });

  btnLoad.addEventListener('click', async () => {
    const file = await pickFile(); if (!file) return;
    const text = await file.text(); const json = JSON.parse(text);
    graph.fromJSON(json);
    selectedElement = null; selectedLink = null; updateSelLabel(); try { KB.ui.refreshSelection(null); } catch {}
  });

  function pickFile() {
    return new Promise(resolve => {
      const inp = Object.assign(document.createElement('input'), { type: 'file', accept: 'application/json' });
      inp.onchange = () => resolve(inp.files?.[0] || null); inp.click();
    });
  }
}

/* -------------------- fatal card -------------------- */
function showFatal(err) {
  const pane = document.getElementById('tab-suggest');
  if (!pane) return alert(String(err));
  const div = document.createElement('div');
  div.className = 'card';
  div.innerHTML = `<div class="title">Startup error</div>
    <div class="small">${String(err && err.message || err)}</div>`;
  pane.innerHTML = ''; pane.appendChild(div);
}

function ensureSessionStart() {
  const modal = document.getElementById('session-modal');
  const part = document.getElementById('part-id');
  const sess = document.getElementById('sess-id');
  const startBtn = document.getElementById('btn-start-session');

  if (sess) sess.value = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);

  const start = () => {
    const chosen = document.querySelector('input[name="scenario"]:checked');
    const scenario_id = (chosen && chosen.value) || 'auth';
    const participant_id = (part.value || '').trim() || 'Px';
    const session_id = (sess.value || '').trim() || new Date().toISOString().replace(/[:.]/g,'-');

    window.__kbSession = { participant_id, session_id, scenario_id };
    try { KB.core.log('session_started', { participant_id, session_id, scenario_id }); } catch {}
    modal.classList.add('hidden');
    document.dispatchEvent(new CustomEvent('kb:session_started', { detail: { participant_id, session_id, scenario_id } }));
  };

  if (startBtn) startBtn.onclick = start;
  if (!window.__kbSession) modal.classList.remove('hidden');

  function enablePanZoom(paper) {
  let scale = 1, MIN = 0.25, MAX = 2.5;
  const svg = paper.svg || paper.el.querySelector('svg');

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const f = e.deltaY < 0 ? 1.1 : 0.9;
    scale = Math.max(MIN, Math.min(MAX, scale * f));
    paper.scale(scale, scale);
  }, { passive: false });

  let panning = false, last = { x: 0, y: 0 };
  svg.addEventListener('mousedown', (e) => {
    // middle-mouse or empty-space drag to pan
    const targetIsNode = e.target.closest('.joint-element');
    if (e.button === 1 || (!targetIsNode && e.button === 0)) {
      panning = true; last = { x: e.clientX, y: e.clientY }; svg.style.cursor = 'grab';
      e.preventDefault();
    }
  });
  window.addEventListener('mousemove', (e) => {
    if (!panning) return;
    const tr = paper.translate();
    paper.translate(tr.tx + (e.clientX - last.x), tr.ty + (e.clientY - last.y));
    last = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('mouseup', () => { panning = false; svg.style.cursor = ''; });
}

function enableAutoResize(paper, graph) {
  const M = 400; // margin around content
  const fit = () => {
    const els = graph.getElements?.() || [];
    if (!els.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of els) {
      const p = el.position(); const s = el.size();
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + s.width); maxY = Math.max(maxY, p.y + s.height);
    }
    const w = Math.max(paper.options.width || 1200, (maxX - minX) + M * 2);
    const h = Math.max(paper.options.height || 700,  (maxY - minY) + M * 2);
    paper.setDimensions(w, h);
  };
  const fitThrottled = (_.throttle ? _.throttle(fit, 200) : fit);
  graph.on('add remove change:position change:size', fitThrottled);
  window.addEventListener('resize', fitThrottled);
  setTimeout(fit, 0);
}

}