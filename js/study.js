// js/study.js — scenario chosen at Start, brief-after-start, Baseline→Assist controls,
// snapshots, JSONL log, panel priming, and bottom-right Scenario Guide (collapsible).

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
  async function fetchScenarioJson(scenario_id) {
    const path = `data/scenarios/${scenario_id}.json`;
    const res = await fetch(path);
    return await res.json();
  }
  function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

  /* ---------------- Scenario Guide widget ---------------- */
  function initScenarioHelpToggle() {
    const wrap = document.getElementById('scenario-help');
    const btn  = document.getElementById('help-toggle');
    if (!wrap || !btn) return;
    btn.onclick = () => {
      wrap.classList.toggle('collapsed');
      const open = !wrap.classList.contains('collapsed');
      btn.textContent = open ? 'Scenario ▾' : 'Scenario ▸';
      btn.setAttribute('aria-expanded', String(open));
    };
  }
  function setScenarioGuideFromJson(js) {
    const cont = document.getElementById('help-content');
    if (!cont) return;

    // Prefer explicit rich text if present
    if (js.guideHtml) {
      cont.innerHTML = js.guideHtml;
      return;
    }

    // Fallback: build from brief + gold lists
    const brief = escapeHtml(js.brief || 'Build an attack tree for the given objective.');
    const must = Array.isArray(js.gold_must_have) ? js.gold_must_have : [];
    const low  = Array.isArray(js.gold_low_value) ? js.gold_low_value : [];

    const mustLis = must.map(x => `<li>${escapeHtml(x)}</li>`).join('');
    const lowLis  = low.map(x  => `<li>${escapeHtml(x)}</li>`).join('');

    cont.innerHTML = `
      <p>${brief}</p>
      <p><strong>Think in branches:</strong> use <em>OR</em> for alternative paths and <em>AND</em> when all steps are required.</p>
      ${must.length ? `<p><strong>Common paths to consider:</strong></p><ul>${mustLis}</ul>` : ''}
      ${low.length  ? `<p><strong>Often out of scope / low value:</strong></p><ul>${lowLis}</ul>` : ''}
      <p class="small">Tip: keep leaves concrete (a single action). Use AND for steps like “reset password” <em>and</em> “access email”.</p>
    `;
  }

  /* ---------------- assistant on/off ---------------- */
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

  /* ---------------- snapshots & priming ---------------- */
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
  function primeAssistantPanels() {
    let label = null;
    try {
      const el = (window.graph?.getElements?.() || [])[0];
      label = el ? (el.attr('label/text') || null) : null;
    } catch {}
    document.dispatchEvent(new CustomEvent('kb:selection', { detail: { parent: label } }));
    try { window.graph?.trigger('change:attrs'); } catch {}
    push('assist_prime', { parent: label });
  }

  /* ---------------- wire on DOM ready ---------------- */
  document.addEventListener('DOMContentLoaded', () => {
    const chip = document.getElementById('study-toolbar');
    chip?.classList.remove('hidden');
    initScenarioHelpToggle();

    const scenSpan = document.getElementById('study-scenario');
    const btnStartAssist  = document.getElementById('btn-start-assist');
    const btnFinishAssist = document.getElementById('btn-finish-assist');
    const btnDownloadLog  = document.getElementById('btn-download-log');
    const btnEndSession   = document.getElementById('btn-end-session');

    window.__studyPhase = 'not_started';
    setAssistantEnabled(false);

    // After Start Session: load chosen scenario, show brief, fill Scenario Guide
    document.addEventListener('kb:session_started', async (e) => {
      const s = e.detail || {};
      if (scenSpan) scenSpan.textContent = `scenario: ${s.scenario_id}`;
      let js;
      try { js = await fetchScenarioJson(s.scenario_id); } catch { js = { brief: 'Build an attack tree for the given objective.' }; }
      const briefText = document.getElementById('brief-text');
      if (briefText) briefText.textContent = (js.brief || 'Build an attack tree for the given objective.').trim();
      document.getElementById('brief-modal')?.classList.remove('hidden');
      setScenarioGuideFromJson(js);

      window.__studyPhase = 'baseline';
      push('phase', { phase: 'baseline_start', scenario_id: s.scenario_id });
    });

    // Start baseline (close brief)
    const briefBtn = document.getElementById('btn-brief-start');
    if (briefBtn) briefBtn.onclick = () => document.getElementById('brief-modal')?.classList.add('hidden');

    // Switch to ASSIST: snapshot v1, enable assistant, prime
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
