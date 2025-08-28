// js/kb-core.js — KB loader + normalization/aliases + Suggest/Prune/Explain engines
// with scenario gold boosting and AND-pair synergy (esp. for Case 1). Prune protects golds.

(function () {
  if (!window.KB) window.KB = {};
  const Core = {};
  KB.core = Core;

  /* ---------------- state ---------------- */
  let CONFIG = {
    suggest: { minScore: 0.35, topK: 3, moreK: 7 },
    prune:   { flagThreshold: 0.45, maxVisible: 3 }
  };
  let KB_RAW = [];
  const BY_ID = new Map();
  const CANON = new Map();
  const ALIAS = new Map();

  // Common patterns that generalize across scenarios (fallbacks)
  const COMMON_IDS = [
    'credential_stuffing','phishing_credentials','password_spraying',
    'password_reset_flow','intercept_reset_email',
    'use_stolen_account_saved_card','use_leaked_card_details',
    'stack_discounts_referrals','item_not_received_refund',
    'join_home_wifi','access_local_interface_rtsp','default_admin_password',
    'default_stream_key','predictable_link_enumeration','find_exposed_links_public',
    'use_shared_device_history','phishing_for_link'
  ];

  // AND-pair synergy (esp. Case 1)
  // If one exists, strongly suggest the other with an AND rationale.
  const AND_PAIRS = [
    { a: 'password_reset_flow', b: 'intercept_reset_email',
      text: 'Password reset typically requires BOTH requesting a reset AND accessing the reset email.' }
  ];

  /* ---------------- utils ---------------- */
  const sev = s => ({ high: 0.7, medium: 0.5, low: 0.3 }[String(s||'').toLowerCase()] ?? 0.4);
  const norm = s => String(s || '')
    .toLowerCase()
    .replace(/[_\-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  function addName(entry, name) {
    const k = norm(name);
    if (k && !CANON.has(k)) CANON.set(k, entry.id);
  }
  function addAlias(entry, alias) {
    const k = norm(alias);
    if (k && !ALIAS.has(k)) ALIAS.set(k, entry.id);
  }
  function canonIdFor(label) {
    const k = norm(label);
    return ALIAS.get(k) || CANON.get(k) || null;
  }
  function inScenario(entry, scenarioId) {
    if (!scenarioId || scenarioId === 'sandbox') return true;
    const list = entry.scenarios || [];
    return list.includes(scenarioId);
  }

  function currentScenarioJson() {
    try { return window.__scenarioJson || null; } catch { return null; }
  }
  function goldIdSet() {
    const js = currentScenarioJson();
    const arr = Array.isArray(js?.gold_must_have) ? js.gold_must_have : [];
    const set = new Set();
    for (const name of arr) {
      const id = canonIdFor(name);
      if (id) set.add(id);
    }
    return set;
  }

  /* ---------------- public: load config & KB ---------------- */
  Core.loadConfig = async function loadConfig() {
    try {
      const res = await fetch('data/config.json', { cache: 'no-store' });
      if (res.ok) CONFIG = { ...CONFIG, ...(await res.json()) };
    } catch (e) { console.warn('[kb-core] config load failed', e); }
  };
  Core.getConfig = () => CONFIG;

  Core.loadKB = async function loadKB() {
    try {
      const res = await fetch('data/attack_patterns.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(`KB fetch failed: ${res.status}`);
      const js = await res.json();
      KB_RAW = Array.isArray(js) ? js : (js.patterns || []);
      BY_ID.clear(); CANON.clear(); ALIAS.clear();
      for (const e of KB_RAW) {
        if (!e.id) continue;
        BY_ID.set(e.id, e);
        addName(e, e.name || e.id);
        (e.aliases || []).forEach(a => addAlias(e, a));
      }
      console.log('[kb-core] KB loaded:', KB_RAW.length, 'entries');
    } catch (e) {
      console.warn('[kb-core] KB load failed', e);
      KB_RAW = [];
    }
  };

  /* ---------------- existing tree introspection ---------------- */
  Core.treeCanonSet = function treeCanonSet(graph) {
    const s = new Set();
    try {
      (graph?.getElements?.() || []).forEach(el => {
        const label = el.attr?.('label/text') || '';
        const id = canonIdFor(label);
        if (id) s.add(id);
      });
    } catch {}
    return s;
  };

  /* ---------------- Suggest engine ---------------- */
  Core.suggest = function suggest({ graph, parentLabel, scenarioId, limitTop = CONFIG.suggest.topK, limitMore = CONFIG.suggest.moreK }) {
    const existingIds = Core.treeCanonSet(graph);
    const parentId = parentLabel ? canonIdFor(parentLabel) : null;
    const golds = goldIdSet();

    // 1) typical children from parent
    const fromParent = [];
    if (parentId) {
      const p = BY_ID.get(parentId);
      const kids = (p?.children || []).map(ch => typeof ch === 'string' ? ch : ch?.id).filter(Boolean);
      for (const kidRef of kids) {
        const kidId = BY_ID.has(kidRef) ? kidRef : canonIdFor(kidRef);
        const e = kidId ? BY_ID.get(kidId) : null;
        if (!e || existingIds.has(e.id)) continue;
        let score = sev(e.severity) + 0.25 + (inScenario(e, scenarioId) ? 0.2 : 0);
        let reason = `Typical child of “${parentLabel}”.`;
        let badge = null;

        // Gold boost
        if (golds.has(e.id)) { score += 0.25; badge = 'must-have'; reason = 'Must-have path for this scenario.'; }

        // AND-pair synergy
        for (const pair of AND_PAIRS) {
          const other = (e.id === pair.a) ? pair.b : (e.id === pair.b ? pair.a : null);
          if (other && existingIds.has(other)) {
            score += 0.20;
            reason = pair.text;
            break;
          }
        }

        fromParent.push({ id: e.id, name: e.name || e.id, source: 'parent', reason, score, badge });
      }
    }

    // 2) scenario-tagged entries not in tree
    const fromScenario = KB_RAW
      .filter(e => inScenario(e, scenarioId) && !existingIds.has(e.id))
      .map(e => {
        let score = sev(e.severity) + 0.2;
        let reason = `Relevant to the chosen scenario.`;
        let badge = null;
        if (golds.has(e.id)) { score += 0.25; reason = 'Must-have path for this scenario.'; badge = 'must-have'; }
        // Pair synergy with existing graph
        for (const pair of AND_PAIRS) {
          const other = (e.id === pair.a) ? pair.b : (e.id === pair.b ? pair.a : null);
          if (other && existingIds.has(other)) { score += 0.20; reason = pair.text; break; }
        }
        return { id: e.id, name: e.name || e.id, source: 'scenario', reason, score, badge };
      });

    // 3) global fallbacks
    const fromCommon = COMMON_IDS
      .map(id => BY_ID.get(id))
      .filter(e => e && !existingIds.has(e.id))
      .map(e => {
        let score = sev(e.severity) + (inScenario(e, scenarioId) ? 0.1 : 0);
        let reason = `Common in many attack trees.`;
        let badge = null;
        if (golds.has(e.id)) { score += 0.25; reason = 'Must-have path for this scenario.'; badge = 'must-have'; }
        for (const pair of AND_PAIRS) {
          const other = (e.id === pair.a) ? pair.b : (e.id === pair.b ? pair.a : null);
          if (other && existingIds.has(other)) { score += 0.20; reason = pair.text; break; }
        }
        return { id: e.id, name: e.name || e.id, source: 'common', reason, score, badge };
      });

    // Combine + dedupe
    const byId = new Map();
    [...fromParent, ...fromScenario, ...fromCommon].forEach(c => {
      const prev = byId.get(c.id);
      if (!prev || c.score > prev.score) byId.set(c.id, c);
    });

    const MIN = CONFIG.suggest.minScore ?? 0.35;
    const ranked = [...byId.values()]
      .filter(c => c.score >= MIN)
      .sort((a,b) => b.score - a.score || a.name.localeCompare(b.name));

    const top  = ranked.slice(0, limitTop);
    const more = ranked.slice(limitTop, limitTop + limitMore);
    return { top, more, parentId, parentLabel };
  };

  /* ---------------- Prune engine ---------------- */
  Core.prune = function prune({ graph, scenarioId, maxVisible = CONFIG.prune.maxVisible }) {
    const elems = graph?.getElements?.() || [];
    const seenName = new Map(); // canonical -> element id
    const flags = [];
    const golds = goldIdSet();

    for (const el of elems) {
      const label = el.attr?.('label/text') || '';
      if (!label) continue;
      if (el.get?.('gate')) continue; // ignore AND/OR gates

      const id = canonIdFor(label);
      const entry = id ? BY_ID.get(id) : null;
      const canonKey = norm(entry?.name || label);

      // Protect scenario golds from pruning
      if (id && golds.has(id)) continue;

      // duplicates
      if (seenName.has(canonKey)) {
        flags.push({
          elementId: el.id,
          label,
          reason: `Looks like a duplicate of “${graph.getCell(seenName.get(canonKey))?.attr?.('label/text') || entry?.name || label}”.`,
          score: 0.15
        });
        continue;
      }
      seenName.set(canonKey, el.id);

      // keep score
      let keep = entry ? sev(entry.severity) : 0.4;
      if (entry) keep += inScenario(entry, scenarioId) ? 0.15 : -0.15;
      if (/^(step|task|misc|other|todo)$/i.test(label.trim())) keep -= 0.25;

      if (keep < (CONFIG.prune.flagThreshold ?? 0.45)) {
        flags.push({
          elementId: el.id,
          label,
          reason: entry
            ? `Low value here given the current scenario and severity (${entry.severity || 'unknown'}).`
            : 'Unrecognized / vague item may be out of scope.',
          score: keep
        });
      }
    }

    return flags.sort((a,b) => a.score - b.score).slice(0, maxVisible);
  };

  /* ---------------- Explain engine ---------------- */
  Core.explain = function explain(label) {
    const id = canonIdFor(label);
    if (!id) {
      return {
        title: label || '—',
        severity: 'unknown',
        summary: 'No specific entry found in the knowledge base for this label.',
        why: ''
      };
    }
    const e = BY_ID.get(id) || {};
    const title = e.name || label;
    const severity = e.severity || 'unknown';
    const summary =
      e.description || e.comms ||
      'This item appears in the KB but lacks a narrative.';
    const why = e.why || '';
    return { title, severity, summary, why };
  };

  /* ---------------- Logging passthrough ---------------- */
  Core.log = function(ev, data) {
    console.log('[kb]', ev, data || {});
  };
})();
