// js/app.js — ports drag-to-link, single small arrowhead at TARGET, center/boundary anchoring,
// pan on blank, add/rename/delete/clear/save/load. No tool overlays or SHIFT hacks.

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

// Use an explicit marker PATH (more robust than "classic" across builds)
const TARGET_MARKER = {
  type: 'path',
  d: 'M 10 -5 L 0 0 L 10 5 z', // small triangle
  stroke: LINK_COLOR,
  fill: LINK_COLOR
};

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
    interactive: { linkMove: false }, // keep links stable once connected
    cellViewNamespace: ns,

    // Default link with ONE arrowhead at the target
    defaultLink: new joint.shapes.standard.Link({
      attrs: {
        line: {
          stroke: LINK_COLOR,
          strokeWidth: 2,
          targetMarker: TARGET_MARKER,      // <— arrow at target only
          sourceMarker: { type: 'none' }    // <— none at source
        }
      },
      router: { name: 'normal' },           // straight unless user bends it
      connector: { name: 'straight' }
    }),

    linkPinning: false,                     // must finish on a magnet
    snapLinks: { radius: 30 },
    validateMagnet: (cv, magnet) => magnet && magnet.getAttribute('magnet') !== 'passive',
    validateConnection: (sv, sm, tv, tm) => sv && tv && sv !== tv && !!sm && !!tm
  });

  // keep paper sized to container
  window.addEventListener('resize', () => {
    const r = pc.getBoundingClientRect();
    paper.setDimensions(r.width || width, r.height || height);
  });

  // expose for other modules
  window.graph = graph; window.paper = paper; window.joint = joint;
  document.dispatchEvent(new CustomEvent('kb:canvas:ready', { detail: { graph, paper } }));
  return { graph, paper };
}

/* -------------------- UI & editing -------------------- */
function wireUI(graph, paper) {
  try { KB.ui.mount(graph, paper); } catch {}

  const RectClass   = joint.shapes?.standard?.Rectangle || joint.shapes?.basic?.Rect;
  const CircleClass = joint.shapes?.standard?.Circle    || joint.shapes?.basic?.Circle;

  // ---- Ports on all 4 sides (drag from any edge) ----
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
      body:  { fill: '#1f2937', stroke: '#6b7280', strokeWidth: 2, magnet: 'passive' }, // body is NOT a magnet
      label: { text: label, fill: '#fff' }
    });
    rect.position(x, y);
    addPorts(rect);
    rect.addTo(graph);
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
      try { KB.ui.refreshSelection({ model: selectedElement }); } catch {}
      updateSelLabel();
    }
  });

  // ----- when a link is created: center anchors + boundary connection point + enforce 1 arrowhead -----
  paper.on('link:connect', (linkView) => {
    const m = linkView.model;
    const srcEl = m.getSourceElement();
    const tgtEl = m.getTargetElement();

    if (srcEl) m.set('source', { id: srcEl.id, anchor: { name: 'center' }, connectionPoint: { name: 'boundary' } });
    if (tgtEl) m.set('target', { id: tgtEl.id, anchor: { name: 'center' }, connectionPoint: { name: 'boundary' } });

    // Ensure exactly one small arrow at TARGET
    m.attr('line/targetMarker', TARGET_MARKER);
    m.attr('line/sourceMarker', { type: 'none' });

    if (typeof m.removeVertices === 'function') m.removeVertices();
    if (typeof linkView.update === 'function') linkView.update();
    if (typeof m.toFront === 'function') m.toFront();
  });

  // link select
  paper.on('link:pointerdown', (view) => { selectedLink = view.model; selectedElement = null; updateSelLabel(); });

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
      try { KB.ui.refreshSelection({ model: selectedElement }); } catch {}
      updateSelLabel();
    }
  });

  btnDel.addEventListener('click', () => {
    if (selectedElement) {
      const links = graph.getConnectedLinks(selectedElement);
      links.forEach(l => l.remove());
      selectedElement.remove();
      selectedElement = null; updateSelLabel(); try { KB.ui.refreshSelection(null); } catch {}
    } else if (selectedLink) {
      selectedLink.remove(); selectedLink = null; updateSelLabel();
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

  // prefill session id
  if (sess) sess.value = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);

  const start = () => {
    // read selected scenario from radio group
    const chosen = document.querySelector('input[name="scenario"]:checked');
    const scenario_id = (chosen && chosen.value) || 'auth';

    const participant_id = (part.value || '').trim() || 'Px';
    const session_id = (sess.value || '').trim() || new Date().toISOString().replace(/[:.]/g,'-');

    // persist on window (read by study.js)
    window.__kbSession = { participant_id, session_id, scenario_id };

    try { KB.core.log('session_started', { participant_id, session_id, scenario_id }); } catch {}
    modal.classList.add('hidden');

    // Tell the study controller we have a scenario now
    document.dispatchEvent(new CustomEvent('kb:session_started', { detail: { participant_id, session_id, scenario_id } }));
  };

  if (startBtn) startBtn.onclick = start;

  // show if not already set
  if (!window.__kbSession) modal.classList.remove('hidden');
}

