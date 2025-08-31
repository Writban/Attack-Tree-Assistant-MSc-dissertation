// js/study.js — Start Session → brief (plain text) → Baseline → Assist flow,
// snapshots (before/after/final), JSONL logger, panel priming, bottom-right Scenario Guide.
// All saved filenames include PARTICIPANT_ID + SCENARIO + STAGE for easier bookkeeping.

(function () {
  /* ---------------- constants ---------------- */
  const SANDBOX_TEXT =
    "Sandbox mode (no fixed scenario).\n\n" +
    "Use this space to freely construct or refine an attack tree. There is no gold standard for this session. " +
    "You can start with any realistic goal (e.g., “Access a user account” or “View camera feed”), then add steps. " +
    "Use OR for alternative paths and AND when all listed steps are required. " +
    "When ready, you can enable assistance to see suggestions, pruning flags, and explanations.";

  /* ---------------- utility: safe names ---------------- */
  function safeSlug(s, fallback = 'anon') {
    const t = String(s || '').trim();
    return t ? t.replace(/[^\w\-]+/g, '_') : fallback;
  }
  function nowIsoSafe() {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }
  function namingParts() {
    const s = window.__kbSession || {};
    return {
      pid: safeSlug(s.participant_id, 'anon'),
      scen: safeSlug(s.scenario_id || (getCfg().experiment?.scenario) || 'scen', 'scen'),
      ts: nowIsoSafe()
    };
  }

  /* ---------------- seed goal as root ---------------- */
  // Seed the canvas with the scenario goal as the root (if not already present)
  function ensureRootGoal(goalLabel) {
    if (!goalLabel || !window.graph) return;
    const els = window.graph.getElements?.() || [];
    const exists = els.some(e => (e.attr?.('label/text') || '').trim().toLowerCase() === goalLabel.trim().toLowerCase());
    if (exists) return;

    const Rect = joint.shapes?.standard?.Rectangle || joint.shapes?.basic?.Rect;
    if (!Rect) return;

    const el = new Rect();
    el.resize(200, 44);
    el.attr({
      body:  { fill: '#1f2937', stroke: '#6b7280', strokeWidth: 2, magnet: 'passive' },
      label: { text: goalLabel, fill: '#fff' }
    });
    el.position(160, 120);
    // add ports like other nodes
    el.set('ports', { groups: {
      left:   { position: { name: 'left' },   attrs: { circle: { r: 5, magnet: true, fill: '#60a5fa', stroke: '#0b0f14' } } },
      right:  { position: { name: 'right' },  attrs: { circle: { r: 5, magnet: true, fill: '#60a5fa', stroke: '#0b0f14' } } },
      top:    { position: { name: 'top' },    attrs: { circle: { r: 5, magnet: true, fill: '#60a5fa', stroke: '#0b0f14' } } },
      bottom: { position: { name: 'bottom' }, attrs: { circle: { r: 5, magnet: true, fill: '#60a5fa', stroke: '#0b0f14' } } }
    }, items: [{group:'left'},{group:'right'},{group:'top'},{group:'bottom'}]});
    el.addTo(window.graph);
    window.autoSizeElement?.(el);

    // make it the current selection context for Suggest/Explain
    try { document.dispatchEvent(new CustomEvent('kb:selection', { detail: { parent: goalLabel } })); } catch {}
    try { KB.core.log('goal_seeded', { goal: goalLabel }); } catch {}
  }

  /* ---------------- logger (JSONL in memory) ---------------- */
  const LOG = [];
  const nowIso = () => new Date().toISOString();

  function push(ev, data) {
    const s = window.__kbSession || {};
    LOG.push({
      ts: nowIso(),
      event: ev,
      participant_id: s.participant_id || null,
      session_id: s.session_id || null,
      scenario_id: s.scenario_id || getCfg().experiment?.scenario || null,
      mode:
        window.__studyPhase === "assist"
          ? "kb"
          : window.__studyPhase === "baseline"
          ? "baseline"
          : "not_started",
      ...data,
    });
  }

  // Wrap KB.core.log so all events also end up in LOG
  if (!window.KB) window.KB = {};
  if (!KB.core) KB.core = {};
  const prevLog = KB.core.log;
  KB.core.log = function (ev, data) {
    try { push(ev, data || {}); } catch {}
    try { prevLog?.(ev, data); } catch {}
  };

  /* ---------------- config & helpers ---------------- */
  function getCfg() {
    try { return KB.core.getConfig?.() || {}; } catch { return {}; }
  }

  function saveFile(name, blob) {
    try { return Utils.saveFile(name, blob); } catch {}
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 0);
  }

  // ---- Tree image export (PNG with participant/scenario/stage) ----
  async function downloadTreeImageForSession(stage = 'current') {
    const { pid, scen } = namingParts();
    await exportPaperPNG(`${pid}__${scen}__${stage}.png`);
  }

  function exportPaperPNG(filename) {
    const paper = window.paper, graph = window.graph;
    if (!paper || !graph) return console.warn('[export] paper/graph not ready');
    const elements = graph.getElements?.() || [];
    if (!elements.length) return console.warn('[export] no elements; skipping image');

    // Compute content bbox (elements only) in graph coords
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of elements) {
      const p = el.position ? el.position() : { x: el.get('position')?.x || 0, y: el.get('position')?.y || 0 };
      const s = el.size ? el.size() : (el.get?.('size') || { width: 200, height: 44 });
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + s.width);
      maxY = Math.max(maxY, p.y + s.height);
    }
    if (!isFinite(minX) || !isFinite(minY)) return console.warn('[export] invalid bbox; skipping');

    const pad = 24;
    const tr = (paper.translate && paper.translate()) || { tx: 0, ty: 0 };
    const vbX = Math.floor(minX + (tr.tx || 0) - pad);
    const vbY = Math.floor(minY + (tr.ty || 0) - pad);
    const vbW = Math.ceil((maxX - minX) + 2 * pad);
    const vbH = Math.ceil((maxY - minY) + 2 * pad);

    // Clone current SVG and set a tight viewBox
    const svgOrig = paper.el.querySelector('svg');
    if (!svgOrig) return console.warn('[export] no svg element');
    const svg = svgOrig.cloneNode(true);
    svg.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);
    svg.setAttribute('width', String(vbW));
    svg.setAttribute('height', String(vbH));

    const svgString = new XMLSerializer().serializeToString(svg);
    const svgBlob = new Blob([svgString], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(svgBlob);

    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.max(1, Math.floor(window.devicePixelRatio || 1));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(vbW * scale));
        canvas.height = Math.max(1, Math.round(vbH * scale));
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, vbW, vbH);
        canvas.toBlob((pngBlob) => {
          try {
            if (pngBlob) Utils.saveFile(filename, pngBlob);
            else Utils.saveFile(filename.replace(/\.png$/i, '.svg'), svgBlob); // fallback
          } finally {
            URL.revokeObjectURL(url);
            resolve();
          }
        }, 'image/png', 1.0);
      };
      img.onerror = () => {
        // Fallback: offer SVG if rasterization fails
        Utils.saveFile(filename.replace(/\.png$/i, '.svg'), svgBlob);
        URL.revokeObjectURL(url);
        resolve();
      };
      img.src = url;
    });
  }

  async function fetchScenarioJson(scenario_id) {
    // Sandbox mode: no fetch; return a virtual scenario object
    if (scenario_id === "sandbox") {
      return { brief: SANDBOX_TEXT, guideText: SANDBOX_TEXT };
    }
    const path = `data/scenarios/${scenario_id}.json`;
    const res = await fetch(path);
    if (!res.ok) throw new Error(`Failed to load scenario ${scenario_id}`);
    return await res.json();
  }

  // Single source of truth for participant-facing text
  function getScenarioPlainText(jsObj) {
    return (jsObj.guideText || jsObj.brief || "Build an attack tree for the given objective.").trim();
  }

  /* ---------------- Scenario Guide widget ---------------- */
  function initScenarioHelpToggle() {
    const wrap = document.getElementById("scenario-help");
    const btn = document.getElementById("help-toggle");
    if (!wrap || !btn) return;
    btn.onclick = () => {
      wrap.classList.toggle("collapsed");
      const open = !wrap.classList.contains("collapsed");
      btn.textContent = open ? "Scenario ▾" : "Scenario ▸";
      btn.setAttribute("aria-expanded", String(open));
    };
  }

  function setScenarioGuideFromJson(jsObj) {
    const cont = document.getElementById("help-content");
    if (!cont) return;
    cont.style.whiteSpace = "pre-wrap"; // preserve newlines
    cont.textContent = getScenarioPlainText(jsObj); // plain text only
  }

  /* ---------------- assistant visibility ---------------- */
  function setAssistantEnabled(on) {
    const kbPanel = document.getElementById("kb-panel");
    if (!kbPanel) return;
    const btnSuggest = kbPanel.querySelector('[data-tab="suggest"]');
    const btnReview = kbPanel.querySelector('[data-tab="review"]');
    const tabSuggest = document.getElementById("tab-suggest");
    const tabReview = document.getElementById("tab-review");

    if (on) {
      if (btnSuggest) btnSuggest.style.display = "";
      if (btnReview) btnReview.style.display = "";
    } else {
      if (btnSuggest) btnSuggest.style.display = "none";
      if (btnReview) btnReview.style.display = "none";
      tabSuggest?.classList.add("hidden");
      tabReview?.classList.add("hidden");
      kbPanel.querySelector('[data-tab="explain"]')?.click?.();
    }

    const modeSpan = document.getElementById("study-mode");
    if (modeSpan) modeSpan.textContent = `mode: ${on ? "kb" : "baseline"}`;
  }

  /* ---------------- snapshots & priming ---------------- */
  function snapshotTree(stageLabel) {
    try {
      const json = window.graph?.toJSON();
      if (!json) throw new Error("no graph");
      const { pid, scen, ts } = namingParts();
      // Normalize stage labels (keep backwards compatibility if legacy tokens passed)
      const stageMap = {
        'v1': 'before_assist',
        'v2': 'after_assist'
      };
      const stage = stageMap[stageLabel] || stageLabel || 'snapshot';
      const name = `${pid}__${scen}__${stage}__${ts}.json`;
      saveFile(name, new Blob([JSON.stringify(json, null, 2)], { type: "application/json" }));
      return name;
    } catch (e) {
      console.error("[study] snapshot failed", e);
      alert("Snapshot failed; see console.");
      return null;
    }
  }

  function primeAssistantPanels() {
    // Choose a context node: current selection → first element → null
    let label = null;
    try {
      const firstEl = (window.graph?.getElements?.() || [])[0];
      label = firstEl ? firstEl.attr("label/text") || null : null;
    } catch {}
    document.dispatchEvent(new CustomEvent("kb:selection", { detail: { parent: label } }));
    try { window.graph?.trigger("change:attrs"); } catch {}
    push("assist_prime", { parent: label });
  }

  /* ---------------- wire on DOM ready ---------------- */
  document.addEventListener("DOMContentLoaded", () => {
    const chip = document.getElementById("study-toolbar");
    chip?.classList.remove("hidden");
    initScenarioHelpToggle();

    const scenSpan = document.getElementById("study-scenario");
    const btnStartAssist = document.getElementById("btn-start-assist");
    const btnFinishAssist = document.getElementById("btn-finish-assist");
    const btnDownloadLog = document.getElementById("btn-download-log");
    const btnEndSession = document.getElementById("btn-end-session");

    window.__studyPhase = "not_started";
    setAssistantEnabled(false);

    // After Start Session: load chosen scenario (or sandbox), show brief, fill Scenario Guide
    document.addEventListener("kb:session_started", async (e) => {
      const s = e.detail || {};
      if (scenSpan) scenSpan.textContent = `scenario: ${s.scenario_id}`;

      let js;
      try {
        js = await fetchScenarioJson(s.scenario_id);
      } catch {
        js = { brief: "Build an attack tree for the given objective." };
      }

      // Plain text narrative for BOTH panels (+ show goal at top if present)
      const plain = getScenarioPlainText(js);
      const briefText = document.getElementById("brief-text");
      if (briefText) {
        briefText.style.whiteSpace = "pre-wrap"; // preserve line breaks
        briefText.textContent = (js.goal ? `Goal (root): ${js.goal}\n\n` : "") + plain;
      }
      setScenarioGuideFromJson(js);

      window.__scenarioJson = js;

      if (js && js.aliases) {
        try {
          KB.core.addScenarioAliases(js.aliases);
          KB.core.log('aliases_loaded', { count: Object.keys(js.aliases).length });
        } catch(e) { console.warn(e); }
      }

      // Seed the root goal node (no effect in sandbox)
      if (js && js.goal) {
        ensureRootGoal(js.goal);
      }

      // Enter baseline phase
      window.__studyPhase = "baseline";
      push("phase", { phase: "baseline_start", scenario_id: s.scenario_id });

      // Show the brief modal now
      document.getElementById("brief-modal")?.classList.remove("hidden");
    });

    // Start baseline (close brief)
    const briefBtn = document.getElementById("btn-brief-start");
    if (briefBtn) {
      briefBtn.onclick = () => {
        document.getElementById("brief-modal")?.classList.add("hidden");
      };
    }

    // Switch to ASSIST: snapshot BEFORE, enable assistant, prime panels
    if (btnStartAssist) {
      btnStartAssist.onclick = () => {
        const snap = snapshotTree("before_assist");
        if (snap) {
          push("baseline_end", { snapshot: snap });
          window.__studyPhase = "assist";
          setAssistantEnabled(true);
          push("assist_start", {});
          primeAssistantPanels();
          alert("Baseline saved. Assistance enabled — continue improving your tree.");
        }
      };
    }

    // Finish ASSIST: snapshot AFTER
    if (btnFinishAssist) {
      btnFinishAssist.onclick = () => {
        const snap = snapshotTree("after_assist");
        if (snap) {
          push("assist_end", { snapshot: snap });
          alert("Final snapshot saved. You can now run the quiz or end the session.");
        }
      };
    }

    // Download log (JSONL) + PNG of current tree (stage-aware)
    if (btnDownloadLog) {
      btnDownloadLog.onclick = async () => {
        const { pid, scen, ts } = namingParts();
        const logName = `${pid}__${scen}__session_log__${ts}.jsonl`;
        const lines = LOG.map((o) => JSON.stringify(o)).join("\n") + "\n";
        saveFile(logName, new Blob([lines], { type: "application/x-ndjson" }));

        // also save an image of the current tree with stage
        const stage = (window.__studyPhase === 'assist')
          ? 'assist_current'
          : (window.__studyPhase === 'baseline' ? 'baseline_current' : 'final');
        await downloadTreeImageForSession(stage);
      };
    }

    // End session: optional FINAL snapshot, then optional log+PNG, reset UI
    if (btnEndSession) {
      btnEndSession.onclick = async () => {
        try { push('session_ui_end_click', {}); } catch {}

        const doSnap = confirm('End session?\n\nOptional: click “OK” to also save a FINAL snapshot of the current tree.\nClick “Cancel” to end without saving a final snapshot.');
        if (doSnap) {
          const name = snapshotTree('final');
          try { push('final_snapshot', { snapshot: name }); } catch {}
        }

        const wantLog = confirm('Download the session log (.jsonl) now?');
        if (wantLog) {
          const { pid, scen, ts } = namingParts();
          const logName = `${pid}__${scen}__session_log__${ts}.jsonl`;
          const lines = LOG.map(o => JSON.stringify(o)).join('\n') + '\n';
          const blob = new Blob([lines], { type: 'application/x-ndjson' });
          (window.Utils?.saveFile ? Utils.saveFile : ((n, b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = n; document.body.appendChild(a); a.click(); setTimeout(()=>{URL.revokeObjectURL(a.href); a.remove();},0); }))(logName, blob);

          // also save an image of the current tree as FINAL
          await downloadTreeImageForSession('final');
        }

        // Clear canvas & session; return to Start Session
        try { window.graph?.clear?.(); } catch {}
        window.__kbSession = null;
        window.__studyPhase = 'not_started';
        try {
          const modeSpan = document.getElementById('study-mode');
          const scenSpan = document.getElementById('study-scenario');
          if (modeSpan) modeSpan.textContent = 'mode: ?';
          if (scenSpan) scenSpan.textContent = 'scenario: ?';
        } catch {}

        // Hide assistant until a new session starts
        try {
          const kbPanel = document.getElementById('kb-panel');
          kbPanel?.querySelector('[data-tab="suggest"]')?.style && (kbPanel.querySelector('[data-tab="suggest"]').style.display = 'none');
          kbPanel?.querySelector('[data-tab="review"]')?.style && (kbPanel.querySelector('[data-tab="review"]').style.display  = 'none');
        } catch {}

        // Re-open Start Session dialog
        document.getElementById('session-modal')?.classList.remove('hidden');
      };
    }

  });
})();
