// js/study.js — scenario from Start Session, brief after start, Baseline→Assist controls,
// tree snapshots, JSONL log, and priming Suggest/Prune/Explain on assist.

(function () {
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
      mode: (window.__studyPhase === 'assist') ? 'kb' : 'baseline',
      ...data
    });
  }
  // wrap KB.core.log if present
  if (!window.KB) window.KB = {};
  if (!KB.core) KB.core = {};
  const prevLog = KB.core.log;
  KB.core.log = function (ev, data) { try { push(ev, data || {}); } catch {} try { prevLog?.(ev, data); } catch {} };

  /* ---------------- config & helpers ---------------- */
  function getCfg() { try { return KB.core.getConfig?.() || {}; } catch { return {}; } }
  function saveFile(name, blob) {
    try { return Utils.saveFile(name, blob); } catch {}
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }
  async function fetchScenarioBrief(scenario_id) {
    const path = `data/scenarios/${scenario_id}.json`;
    try { const res = await fetch(path); const js = await res.json(); return (js.brief || '').trim(); }
    catch { return 'Build an attack tree for the given objective.'; }
  }

  /* ---------------- UI gates (assistant on/off) ---------------- */
  function setAssistantEnabled(on) {
    const kbPanel = document.getElementById('kb-panel');
    if (!kbPanel) return;
    const btnSuggest = kbPanel.querySelector('[data-tab="suggest"]');
    const btnReview  = kbPanel.querySelector('[data-tab="review"]');
    const tabSuggest = document.getElementById('tab-suggest');
    const tabReview  = document.getElementById('tab-review');
    if (on) {
      if (btnSuggest) btnSuggest.style.display = '';
      if (btnReview)  btnReview.style.display = '';
    } else {
      if (btnSuggest) btnSuggest.style.display = 'none';
      if (btnReview)  btnReview.style.display  = 'none';
      tabSuggest?.classList.add('hidden');
      tabReview?.classList.add('hidden');
      kbPanel.querySelector('[data-tab="explain"]')?.click?.();
    }
    const modeSpan = document.getElementById('study-mode');
    if (modeSpan) modeSpan.textContent = `mode: ${on ? 'kb' : 'baseline'}`;
  }

  /* ---------------- snapshots ---------------- */
  function snapshotTree(suffix) {
    try {
      const s = window.__kbSession || {};
      const json = window.graph?.toJSON();
      if (!json) throw new Error('no graph');
      const name = `tree_${suffix}_${s.scenario_id || 'scen'}_${s.session_id || nowIso().replace(/[:.]/g,'-')}.json`;
      saveFile(name, new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }));
      return name;
    } catch (e) { console.error('[study] snapshot failed', e); alert('Snapshot failed; see console.'); return null; }
  }

  /* ---------------- prime assistant panels ---------------- */
  function primeAssistantPanels() {
    // choose a parent: current selection → first element → null
    let label = null;
    try {
      const sel = window.paper?.findViewById?.(window.__selectedId || '')?.model;
      if (sel) label = sel.attr('label/text') || null;
    } catch {}
    if (!label) {
      const el = (window.graph?.getElements?.() || [])[0];
      label = el ? (el.attr('label/text') || null) : null;
    }

    // Fire selection event so Suggest/Explain render for that node
    document.dispatchEvent(new CustomEvent('kb:selection', { detail: { parent: label } }));

    // Also nudge prune to recompute (kb-ui listens to graph events; this is a safe no-op change)
    try { window.graph?.trigger('change:attrs'); } catch {}
    push('assist_prime', { parent: label });
  }

  /* ---------------- wire on DOM ready ---------------- */
  document.addEventListener('DOMContentLoaded', () => {
    const chip = document.getElementById('study-toolbar');
    chip?.classList.remove('hidden');

    const scenSpan = document.getElementById('study-scenario');
    const btnStartAssist  = document.getElementById('btn-start-assist');
    const btnFinishAssist = document.getElementById('btn-finish-assist');
    const btnDownloadLog  = document.getElementById('btn-download-log');
    const btnEndSession   = document.getElementById('btn-end-session');

    // Start in a neutral state until session is started
    window.__studyPhase = 'not_started';
    setAssistantEnabled(false);

    // When Start Session completes, show the brief for the chosen scenario
    document.addEventListener('kb:session_started', async (e) => {
      const s = e.detail || {};
      if (scenSpan) scenSpan.textContent = `scenario: ${s.scenario_id}`;
      const brief = await fetchScenarioBrief(s.scenario_id);
      const briefText = document.getElementById('brief-text');
      if (briefText) briefText.textContent = brief;
      document.getElementById('brief-modal')?.classList.remove('hidden');

      // set Baseline phase only now
      window.__studyPhase = 'baseline';
      push('phase', { phase: 'baseline_start', scenario_id: s.scenario_id });
    });

    // Start baseline after reading brief
    const briefBtn = document.getElementById('btn-brief-start');
    if (briefBtn) {
      briefBtn.onclick = () => {
        document.getElementById('brief-modal')?.classList.add('hidden');
      };
    }

    // Switch to ASSIST: snapshot v1, enable assistant, prime panels
    if (btnStartAssist) {
      btnStartAssist.onclick = () => {
        const snap = snapshotTree('v1');
        if (snap) {
          push('baseline_end', { snapshot: snap });
          window.__studyPhase = 'assist';
          setAssistantEnabled(true);
          push('assist_start', {});
          primeAssistantPanels();
          alert('Baseline saved. Assistance enabled — continue improving your tree.');
        }
      };
    }

    // Finish ASSIST: snapshot v2
    if (btnFinishAssist) {
      btnFinishAssist.onclick = () => {
        const snap = snapshotTree('v2');
        if (snap) {
          push('assist_end', { snapshot: snap });
          alert('Final snapshot saved. You can now run the quiz or end the session.');
        }
      };
    }

    // Download log
    if (btnDownloadLog) {
      btnDownloadLog.onclick = () => {
        const s = window.__kbSession || {};
        const name = `log_${s.scenario_id || 'scen'}_${s.session_id || nowIso().replace(/[:.]/g,'-')}.jsonl`;
        const lines = LOG.map(o => JSON.stringify(o)).join('\n') + '\n';
        saveFile(name, new Blob([lines], { type: 'application/x-ndjson' }));
      };
    }

    // End session: also log here
    if (btnEndSession) {
      const prev = btnEndSession.onclick;
      btnEndSession.onclick = (e) => { try { push('session_ui_end', {}); } catch {} prev?.(e); };
    }
  });
})();
