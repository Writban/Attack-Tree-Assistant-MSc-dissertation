// js/study.js — Start Session → brief (plain text) → Baseline → Assist flow,
// snapshots (tree_v1/tree_v2), JSONL logger, panel priming, and bottom-right Scenario Guide.
// BOTH the brief modal and the Scenario Guide show the SAME plain-text narrative
// from scenario JSON (guideText preferred, else brief). In 'sandbox' mode, no fetch;
// show a generic exam-style statement instead.

(function () {
  /* ---------------- constants ---------------- */
  const SANDBOX_TEXT =
    "Sandbox mode (no fixed scenario).\n\n" +
    "Use this space to freely construct or refine an attack tree. There is no gold standard for this session. " +
    "You can start with any realistic goal (e.g., “Access a user account” or “View camera feed”), then add steps. " +
    "Use OR for alternative paths and AND when all listed steps are required. " +
    "When ready, you can enable assistance to see suggestions, pruning flags, and explanations.";

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
  function snapshotTree(suffix) {
    try {
      const s = window.__kbSession || {};
      const json = window.graph?.toJSON();
      if (!json) throw new Error("no graph");
      const safeSid = (s.session_id || nowIso()).replace(/[:.]/g, "-");
      const name = `tree_${suffix}_${s.scenario_id || "scen"}_${safeSid}.json`;
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

      // Plain text narrative for BOTH panels
      const plain = getScenarioPlainText(js);
      const briefText = document.getElementById("brief-text");
      if (briefText) {
        briefText.style.whiteSpace = "pre-wrap"; // preserve line breaks
        briefText.textContent = plain;
      }
      setScenarioGuideFromJson(js);

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

    // Switch to ASSIST: snapshot v1, enable assistant, prime panels
    if (btnStartAssist) {
      btnStartAssist.onclick = () => {
        const snap = snapshotTree("v1");
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

    // Finish ASSIST: snapshot v2
    if (btnFinishAssist) {
      btnFinishAssist.onclick = () => {
        const snap = snapshotTree("v2");
        if (snap) {
          push("assist_end", { snapshot: snap });
          alert("Final snapshot saved. You can now run the quiz or end the session.");
        }
      };
    }

    // Download log (JSONL)
    if (btnDownloadLog) {
      btnDownloadLog.onclick = () => {
        const s = window.__kbSession || {};
        const safeSid = (s.session_id || nowIso()).replace(/[:.]/g, "-");
        const name = `log_${s.scenario_id || "scen"}_${safeSid}.jsonl`;
        const lines = LOG.map((o) => JSON.stringify(o)).join("\n") + "\n";
        saveFile(name, new Blob([lines], { type: "application/x-ndjson" }));
      };
    }

    // End session: also log here
    if (btnEndSession) {
      const prev = btnEndSession.onclick;
      btnEndSession.onclick = (e) => {
        try { push("session_ui_end", {}); } catch {}
        prev?.(e);
      };
    }
  });
})();
