// js/kb-core.js — Suggest/Prune/Explain with:
// - stop-word aware normalization
// - alias + fuzzy matching (edit distance + token overlap)
// - structural prune flags: orphan nodes, dangling/unary gates
// - keeps prior gold boosts, AND-pair synergy, gold-protected prune, resolve(), log()

(function () {
  if (!window.KB) window.KB = {};
  const Core = {};
  KB.core = Core;

  /* ---------------- state ---------------- */
  let CONFIG = {
    suggest: { minScore: 0.35, topK: 3, moreK: 7 },
    prune:   { flagThreshold: 0.45, maxVisible: 3 },
    fuzzy:   { enabled: true, maxDistance: 2, tokenOverlapMin: 0.6 }
  };
  let KB_RAW = [];
  const BY_ID = new Map();
  const CANON = new Map(); // normalized canonical name -> id
  const ALIAS = new Map(); // normalized alias -> id

  const STOP = new Set(['the','a','an','of','for','to','and','or','via','with','on','in','by','from','into','using']);

  // Minimal categories for AND-misuse detection
const CATS = {
  // credential acquisition alternatives
  'CS': 'credential_acquisition',
  'password_spraying': 'credential_acquisition',
  'phishing_credentials': 'credential_acquisition',
  // recovery flow
  'password_reset_flow': 'recovery_flow',
  'intercept_reset_email': 'recovery_flow',
  // iot local access
  'join_home_wifi': 'local_access',
  'access_local_interface_rtsp': 'local_access',
  // checkout payment routes
  'use_leaked_card_details': 'payment_fraud',
  'use_stolen_account_saved_card': 'payment_fraud'
};


  const COMMON_IDS = [
  'credential_stuffing','phishing_credentials','password_spraying',
  'password_reset_flow','intercept_reset_email',
  'use_stolen_account_saved_card','use_leaked_card_details',
  'stack_discounts_referrals','item_not_received_refund',
  'join_home_wifi','access_local_interface_rtsp','default_admin_password',
  'default_stream_key','predictable_link_enumeration','find_exposed_links_public',
  'use_shared_device_history','phishing_for_link',
  // Generic fallbacks for Sandbox/random cases
  'no_mfa_or_weak_mfa','default_credentials_generic','idor_generic','predictable_ids',
  'session_fixation','weak_password_policy','sql_injection_basic','xss_reflected',
  'public_bucket_exposure','horizontal_privilege_escalation','vertical_privilege_escalation',
  'pretext_call','abuse_export_download','insecure_security_questions'
];


  // AND-pair synergy (esp. Case 1)
  const AND_PAIRS = [
    { a: 'password_reset_flow', b: 'intercept_reset_email',
      text: 'Password reset typically requires BOTH requesting a reset AND accessing the reset email.' }
  ];

  /* ---------------- utils ---------------- */
  function sev(s){ return ({high:0.7,medium:0.5,low:0.3}[String(s||'').toLowerCase()] ?? 0.4); }

  function tokensOf(s) {
    return String(s||'')
      .toLowerCase()
      .replace(/[_\-]+/g,' ')
      .replace(/[^a-z0-9 ]+/g,' ')
      .split(/\s+/)
      .filter(t => t && !STOP.has(t));
  }
  function norm(s){ return tokensOf(s).join(' '); }

  function addName(entry, name) {
    const k = norm(name);
    if (k && !CANON.has(k)) CANON.set(k, entry.id);
  }
  function addAlias(entry, alias) {
    const k = norm(alias);
    if (k && !ALIAS.has(k)) ALIAS.set(k, entry.id);
  }

  function editDistance(a,b) { // classic Levenshtein
    const m=a.length, n=b.length;
    if (!m) return n; if (!n) return m;
    const dp=new Array(n+1); for(let j=0;j<=n;j++) dp[j]=j;
    for(let i=1;i<=m;i++){
      let prev=dp[0]; dp[0]=i;
      for(let j=1;j<=n;j++){
        const tmp=dp[j];
        dp[j]= (a[i-1]===b[j-1]) ? prev : Math.min(prev+1, dp[j-1]+1, dp[j]+1);
        prev=tmp;
      }
    }
    return dp[n];
  }

  function tokenOverlap(aTokens, bTokens) {
    const A = new Set(aTokens), B = new Set(bTokens);
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    const denom = Math.max(1, A.size, B.size);
    return inter / denom;
  }

  // exact -> alias/canon; else fuzzy by tokens & distance
  function canonIdFor(label) {
    const k = norm(label);
    if (!k) return null;
    let id = ALIAS.get(k) || CANON.get(k);
    if (id) return id;

    if (!(CONFIG.fuzzy?.enabled)) return null;

    const aTok = k.split(' ');
    let best = { id:null, score:-1 };

    // search aliases first (more likely matches), then canonicals
    const tryMap = (map) => {
      for (const [key, valId] of map.entries()) {
        const bTok = key.split(' ');
        const over = tokenOverlap(aTok, bTok);
        if (over < (CONFIG.fuzzy.tokenOverlapMin ?? 0.6)) continue;
        const dist = editDistance(k, key);
        if (dist > (CONFIG.fuzzy.maxDistance ?? 2)) continue;
        const score = over - (dist * 0.05);
        if (score > best.score) best = { id: valId, score };
      }
    };
    tryMap(ALIAS); tryMap(CANON);
    return best.id;
  }

  function inScenario(entry, scenarioId) {
    if (!scenarioId || scenarioId === 'sandbox') return true;
    const list = entry.scenarios || [];
    return list.includes(scenarioId);
  }

  function currentScenarioJson(){ try { return window.__scenarioJson || null; } catch { return null; } }
  function goldIdSet() {
    const js = currentScenarioJson();
    const arr = Array.isArray(js?.gold_must_have) ? js.gold_must_have : [];
    const set = new Set();
    for (const name of arr) { const id = canonIdFor(name); if (id) set.add(id); }
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

        if (golds.has(e.id)) { score += 0.25; badge = 'must-have'; reason = 'Must-have path for this scenario.'; }

        for (const pair of AND_PAIRS) {
          const other = (e.id === pair.a) ? pair.b : (e.id === pair.b ? pair.a : null);
          if (other && existingIds.has(other)) { score += 0.20; reason = pair.text; break; }
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

  /* ---------------- helpers: graph topology ---------------- */
  function gateChildren(graph, el) {
    try {
      const links = graph.getConnectedLinks(el, { outbound: true });
      const kids = [];
      for (const l of links) {
        const tgtId = l.get('target')?.id;
        if (!tgtId) continue;
        const t = graph.getCell(tgtId);
        if (t?.isElement?.()) kids.push(t);
      }
      return kids;
    } catch { return []; }
  }
  function degree(graph, el) {
    try { return graph.getConnectedLinks(el).length; } catch { return 0; }
  }

  /* ---------------- Prune engine ---------------- */
  Core.prune = function prune({ graph, scenarioId, maxVisible = CONFIG.prune.maxVisible }) {
    const elems = graph?.getElements?.() || [];
    const seenName = new Map(); // canonical -> element id
    const flags = [];
    const golds = goldIdSet();

    // Structural: orphans, gates with <2 children, gate with 0 children
    for (const el of elems) {
      const label = el.attr?.('label/text') || '';
      const isGate = !!el.get?.('gate');
      const deg = degree(graph, el);

      if (isGate) {
        const kids = gateChildren(graph, el);
        if (kids.length === 0) {
          flags.push({ elementId: el.id, label: label || `${el.get('gate')} gate`,
            reason: 'Gate has no children — incomplete structure.', score: 0.10 });
          continue;
        }
        if (kids.length === 1) {
          flags.push({ elementId: el.id, label: label || `${el.get('gate')} gate`,
            reason: 'Gate has only one child — consider removing the gate or adding another child.', score: 0.20 });
        }
        continue; // skip further value checks for gates
      }

      if (el.get('gate') === 'AND' && kids.length >= 2) {
  // Look up categories of children
  const childCats = kids.map(k => {
    const lbl = k.attr?.('label/text') || '';
    const id = canonIdFor(lbl);
    return id ? CATS[id] : null;
  }).filter(Boolean);

  // If two or more children share the same category that's normally alternative, warn once.
  const altCats = new Set(['credential_acquisition','payment_fraud']);
  const counts = {};
  for (const c of childCats) counts[c] = (counts[c] || 0) + 1;

  for (const [cat, n] of Object.entries(counts)) {
    if (altCats.has(cat) && n >= 2) {
      flags.push({
        elementId: el.id,
        label: `${el.get('gate')} gate`,
        reason: 'This AND groups alternative tactics that usually stand as OR siblings (e.g., multiple ways to get credentials).',
        score: 0.25
      });
      break; // one flag is enough
    }
  }
}


      if (deg === 0) {
        flags.push({ elementId: el.id, label: label || 'node',
          reason: 'Unlinked node — attach to a parent/child or remove.', score: 0.30 });
      }
    }

    // Content-level flags (duplicates, vague/low value), protecting golds
    for (const el of elems) {
      if (el.get?.('gate')) continue; // handled above
      const label = el.attr?.('label/text') || '';
      if (!label) continue;

      const id = canonIdFor(label);
      const entry = id ? BY_ID.get(id) : null;
      const canonKey = norm(entry?.name || label);

      if (id && golds.has(id)) continue; // protect scenario golds

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

      let keep = entry ? sev(entry.severity) : 0.4;
      if (entry) keep += inScenario(entry, scenarioId) ? 0.15 : -0.15;

      if (/^(step|task|misc|other|todo|thing|stuff)$/i.test(label.trim())) keep -= 0.25;
      if (label.trim().length <= 3) keep -= 0.25; // very short/ambiguous

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

  /* ---------------- Explain & resolve ---------------- */
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
    const summary = e.description || e.comms || 'This item appears in the KB but lacks a narrative.';
    const why = e.why || '';
    return { title, severity, summary, why };
  };

  Core.resolve = function resolve(label) {
    const id = canonIdFor(label);
    return { id, entry: id ? (BY_ID.get(id) || null) : null };
  };

  Core.addScenarioAliases = function(aliasMap) {
  if (!aliasMap) return;
  for (const [alias, canonical] of Object.entries(aliasMap)) {
    const id = (function () {
      const k = String(canonical || '').toLowerCase().replace(/[_\-]+/g,' ').replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
      return (ALIAS.get(k) || CANON.get(k) || null);
    })();
    if (!id) continue;
    const k = String(alias || '').toLowerCase().replace(/[_\-]+/g,' ').replace(/[^a-z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
    if (k && !ALIAS.has(k)) ALIAS.set(k, id);
  }
};

  /* ---------------- Logging passthrough ---------------- */
  Core.log = function(ev, data) { console.log('[kb]', ev, data || {}); };
})();
