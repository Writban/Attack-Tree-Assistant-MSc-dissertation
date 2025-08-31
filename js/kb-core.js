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
  'credential_stuffing': 'credential_acquisition',
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

Core.prune = function prune({ graph, scenarioId, maxVisible = (CONFIG.prune?.maxVisible ?? 3) }) {
  const flags = [];
  if (!graph) return flags;

  const els = graph.getElements?.() || [];
  if (!els.length) return flags;

  // Helpers
  const linksOf = (el) => graph.getConnectedLinks?.(el) || [];
  const kidsOf  = (el) => gateChildren(graph, el);

  const scen = (typeof window !== 'undefined' ? (window.__scenarioJson || {}) : {});
  const goalText = (scen.goal || '').trim().toLowerCase();
  const goldIds  = goldIdSet(); // must-haves (protected)
  const lowVals  = Array.isArray(scen.gold_low_value) ? scen.gold_low_value : [];

  // --- 1) Structural flags ---
  for (const el of els) {
    const label = el.attr?.('label/text') || '';
    const isGate = !!el.get?.('gate');
    const labelN = (label || '').trim().toLowerCase();

    if (isGate) {
      const kids = kidsOf(el);
      if (kids.length === 0) {
        flags.push({ elementId: el.id, label: label || `${el.get('gate')} gate`, reason: 'Gate has no children — incomplete structure.', score: 0.10 });
        continue;
      }
      if (kids.length === 1) {
        flags.push({ elementId: el.id, label: label || `${el.get('gate')} gate`, reason: 'Gate has only one child — add another child or remove the gate.', score: 0.20 });
      }

      // AND misuse: alternative tactics grouped under AND
      if (el.get('gate') === 'AND' && kids.length >= 2) {
        const childCats = kids.map(k => {
          const lbl = k.attr?.('label/text') || '';
          const id  = canonIdFor(lbl);
          return id ? CATS[id] : null;
        }).filter(Boolean);

        const altCats = new Set(['credential_acquisition','payment_fraud']);
        const counts = {};
        for (const c of childCats) counts[c] = (counts[c] || 0) + 1;

        for (const [cat, n] of Object.entries(counts)) {
          if (altCats.has(cat) && n >= 2) {
            flags.push({
              elementId: el.id,
              label: `${el.get('gate')} gate`,
              reason: 'This AND groups alternatives that usually belong under an OR (e.g., multiple ways to get credentials).',
              score: 0.25
            });
            break;
          }
        }
      }
      continue; // don’t do content checks on gates
    }

    // Orphans (no links)
    const links = linksOf(el);
    const out = links.filter(l => l.getSourceElement?.()?.id === el.id || l.get('source')?.id === el.id).length;
    const inc = links.filter(l => l.getTargetElement?.()?.id === el.id || l.get('target')?.id === el.id).length;
    if (out === 0 && inc === 0 && labelN !== goalText) {
      flags.push({ elementId: el.id, label, reason: 'Unlinked node — attach to a parent/child or remove.', score: 0.30 });
    }
  }

  // --- 2) Content flags: duplicates / low-value / vague ---
  // Build seen map for duplicates based on canonical id; fallback to fuzzy if unknown.
  const seen = new Map(); // key -> elementId
  function sameConcept(a, b) {
    // prefer canonical ids
    const ca = canonIdFor(a), cb = canonIdFor(b);
    if (ca && cb) return ca === cb;
    // fallback: token overlap + small edit distance
    const aTok = tokensOf(a), bTok = tokensOf(b);
    const overlap = tokenOverlap(aTok, bTok);     // 0..1
    const dist    = editDistance(norm(a), norm(b));
    return (overlap >= 0.7) && (dist <= 2);
  }

  for (const el of els) {
    if (el.get?.('gate')) continue;                 // only structural on gates
    const label = el.attr?.('label/text') || '';
    const labelN = (label || '').trim().toLowerCase();
    if (!label) continue;
    if (labelN === goalText) continue;              // never flag the goal

    const id = canonIdFor(label);
    if (id && goldIds.has(id)) continue;            // protect scenario must-haves

    // Duplicates
    let dupKey = id ? `id:${id}` : `n:${norm(label)}`;
    if (seen.size) {
      for (const [k, firstId] of seen.entries()) {
        const kLabel = graph.getCell(firstId)?.attr?.('label/text') || '';
        if (sameConcept(label, kLabel)) { dupKey = k; break; }
      }
    }
    if (seen.has(dupKey)) {
      const firstLabel = graph.getCell(seen.get(dupKey))?.attr?.('label/text') || '';
      flags.push({
        elementId: el.id,
        label,
        reason: `Near-duplicate of “${firstLabel}” — consider merging or renaming.`,
        score: 0.40
      });
      continue;
    }
    seen.set(dupKey, el.id);

    // Known low-value/distractor (scenario)
    const isLow = lowVals.some(lv => {
      const lvId = canonIdFor(lv);
      if (lvId && id) return lvId === id;
      return sameConcept(label, lv);
    });
    if (isLow) {
      flags.push({
        elementId: el.id,
        label,
        reason: 'Low-value/distractor for this scenario — consider removing or moving to notes.',
        score: 0.35
      });
      continue;
    }

    // Vague/generic
    const toks = tokensOf(label);
    const tooShort = toks.length < 2; // tunable if you add to CONFIG
    const generic = /\b(thing|stuff|misc|todo|do attack|hack|bypass|get in|perform attack)\b/i.test(label);
    if (tooShort || generic) {
      flags.push({
        elementId: el.id,
        label,
        reason: tooShort
          ? 'Label is too short/vague — rename to a concrete step.'
          : 'Generic wording — rename to a specific step for clarity.',
        score: 0.45
      });
    }
  }

  // Deduplicate flags per element (keep highest severity/lowest score number)
  const byId = new Map();
  for (const f of flags) {
    const prev = byId.get(f.elementId);
    if (!prev || f.score < prev.score) byId.set(f.elementId, f);
  }
  const out = Array.from(byId.values())
    .sort((a, b) => a.score - b.score)
    .slice(0, maxVisible);

  Core.log('prune_candidates', { count: out.length });
  return out;
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

  /* =======================================================================
   v2 Matching & Pruning Upgrade — canonicalizer, fuzzy resolve, dup filter
   Paste just before the IIFE closes.
   ======================================================================= */

(function UpgradeMatchingAndPrune() {
  if (!window.KB || !KB.core) return;
  const Core = KB.core;

  // ---- config thresholds (fallbacks if not in /data/config.json) ----
  const cfg = (Core.getConfig && Core.getConfig()) || {};
  const matchCfg = cfg.matching || {};
  const T_HIGH = typeof matchCfg.fuzzyThreshold === 'number' ? matchCfg.fuzzyThreshold : 0.85; // "same thing"
  const T_MED  = (typeof matchCfg.softThreshold === 'number' ? matchCfg.softThreshold : 0.70); // "close enough"
  const MIN_SCORE = typeof matchCfg.minScore === 'number' ? matchCfg.minScore : 0.35;

  // ---- canonicalization ----
  const STOP = new Set([
    'the','a','an','and','or','to','of','for','in','on','with','via','by','from','as',
    'user','users','account','accounts','system','site','app','application','page','pages',
    'do','does','make','get','got','have','has','be','is','are','was','were','can','could',
    'into','out','at','this','that','these','those'
  ]);

  function norm(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[_/\\\-]+/g, ' ')
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function stem(tok) {
    if (tok.length <= 3) return tok;
    return tok
      .replace(/(ing|ed|ers|er|ies|s)$/,'')
      .replace(/(ion|ions)$/,'ion'); // light stem; keeps meaning
  }

  function tokens(s) {
    const n = norm(s);
    return n.split(' ')
      .filter(Boolean)
      .map(stem)
      .filter(t => !STOP.has(t));
  }

  function trigrams(n) {
    // n should be normalized (no punctuation)
    const s = n.replace(/\s+/g,' ');
    const out = [];
    for (let i = 0; i < s.length - 2; i++) out.push(s.slice(i, i+3));
    return out;
  }

  function jaccard(a, b) {
    if (!a.length && !b.length) return 1;
    const A = new Set(a), B = new Set(b);
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    const uni = A.size + B.size - inter;
    return uni ? inter / uni : 0;
  }

  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    const dp = new Array(n + 1);
    for (let j = 0; j <= n; j++) dp[j] = j;
    for (let i = 1; i <= m; i++) {
      let prev = dp[0], cur;
      dp[0] = i;
      for (let j = 1; j <= n; j++) {
        cur = dp[j];
        if (a[i - 1] === b[j - 1]) dp[j] = prev;
        else dp[j] = Math.min(prev + 1, dp[j] + 1, dp[j - 1] + 1);
        prev = cur;
      }
    }
    return dp[n];
  }

  function strSim(aRaw, bRaw) {
    const aN = norm(aRaw), bN = norm(bRaw);
    if (!aN && !bN) return 1;
    const aT = tokens(aRaw), bT = tokens(bRaw);
    const aG = trigrams(aN), bG = trigrams(bN);
    const jTok = jaccard(aT, bT);
    const jTri = jaccard(aG, bG);
    const lev  = 1 - (levenshtein(aN, bN) / Math.max(aN.length, bN.length, 1));
    // weighted combo
    return 0.6 * jTok + 0.3 * jTri + 0.1 * lev;
  }

  // ---- Build a light index from the internal KB maps (BY_ID etc) ----
  // Note: We rely on kb-core.js having BY_ID and canonIdFor in scope.
  // If your file names differ, adjust here.
  if (typeof BY_ID === 'undefined') {
    console.warn('[KB] BY_ID map not found; fuzzy index disabled');
    return;
  }

  let INDEX = [];
  function buildIndex() {
    INDEX = [];
    BY_ID.forEach((entry, id) => {
      const name = entry.name || id;
      const fields = [
        { kind: 'name', raw: name, n: norm(name), t: tokens(name), g: trigrams(norm(name)) }
      ];
      const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
      for (const a of aliases) {
        const an = norm(a);
        fields.push({ kind: 'alias', raw: a, n: an, t: tokens(a), g: trigrams(an) });
      }
      INDEX.push({ id, entry, fields });
    });
  }
  buildIndex();

  // --- put inside UpgradeMatchingAndPrune(), after buildIndex() ---

// Top-k closest KB entries for an arbitrary label (no hard threshold)
Core.closest = function closest(label, k = 3) {
  if (!label) return [];
  const labelN = norm(label);
  const scored = INDEX.map(item => {
    let s = 0;
    for (const f of item.fields) {
      const sf = strSim(labelN, f.n);
      if (sf > s) s = sf;
    }
    return { id: item.id, entry: item.entry, score: s };
  }).sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
};

// Always give an explanation. If we only have a fuzzy hit, include a hint.
Core.explain = function explain(idOrName) {
  // exact id?
  if (BY_ID.has(idOrName)) {
    const e = BY_ID.get(idOrName);
    return { title: e.name || e.id, severity: e.severity || 'unknown',
             summary: e.description || e.comms || e.why || 'No explanation available.' };
  }
  // canonical?
  const cid = (typeof canonIdFor === 'function') ? canonIdFor(idOrName) : null;
  if (cid && BY_ID.has(cid)) {
    const e = BY_ID.get(cid);
    return { title: e.name || cid, severity: e.severity || 'unknown',
             summary: e.description || e.comms || e.why || 'No explanation available.' };
  }
  // fuzzy fallback
  const [best, ...rest] = Core.closest(idOrName, 3);
  if (best && best.entry) {
    const body = best.entry.description || best.entry.comms || best.entry.why || 'No explanation available.';
    const hint = `Closest match (${Math.round(best.score * 100)}%): ${best.entry.name || best.id}`;
    return {
      title: String(idOrName || ''),
      severity: best.entry.severity || 'unknown',
      summary: `${body}\n\n${hint}`,
      why: 'Fuzzy matched',
      candidates: [best, ...rest]
    };
  }
  return { title: String(idOrName || ''), severity: 'unknown', summary: 'No explanation available.' };
};


  function bestMatch(label) {
    if (!label) return null;
    // quick exact/id match
    if (BY_ID.has(label)) return { id: label, entry: BY_ID.get(label), method: 'id', score: 1 };
    const labelN = norm(label);
    let best = { id: null, entry: null, method: 'none', score: 0 };
    for (const item of INDEX) {
      for (const f of item.fields) {
        const s = strSim(labelN, f.n);
        if (s > best.score) best = { id: item.id, entry: item.entry, method: f.kind, score: s };
        if (best.score >= 0.999) break;
      }
    }
    return best.id ? best : null;
  }

  // Expose improved resolve/explain
  Core.resolve = function resolve(idOrName) {
    if (!idOrName) return null;
    // exact id or canonical id first if available
    if (BY_ID.has(idOrName)) return { id: idOrName, entry: BY_ID.get(idOrName), score: 1, method: 'id' };
    const cid = (typeof canonIdFor === 'function') ? canonIdFor(idOrName) : null;
    if (cid && BY_ID.has(cid)) return { id: cid, entry: BY_ID.get(cid), score: 1, method: 'canon' };
    // fuzzy fallback
    const bm = bestMatch(idOrName);
    return bm || null;
  };

  Core.explain = function explain(idOrName) {
    const res = Core.resolve(idOrName);
    if (!res || !res.entry) {
      return { title: String(idOrName || ''), severity: 'unknown', summary: 'No explanation available.' };
    }
    const e = res.entry;
    const title = e.name || res.id;
    const body  = e.description || e.comms || e.why || 'No explanation available.';
    const hint  = (res.method === 'alias' || res.method === 'name' || res.score < 1) ? `Closest match: ${title}` : '';
    return {
      title, severity: (e.severity || 'unknown'),
      summary: body + (hint ? `\n\n${hint}` : ''),
      why: e.why || ''
    };
  };

  // ---- Duplicate suppression for Suggest (wrapper, non-invasive) ----
  const _origSuggest = Core.suggest;
  Core.suggest = function wrappedSuggest(args) {
    const out = (_origSuggest && _origSuggest.call(Core, args)) || { top: [], more: [], parentLabel: null };
    const graph = args && args.graph;
    const labels = (graph && graph.getElements && graph.getElements().map(e => e.attr && e.attr('label/text')).filter(Boolean)) || [];
    function isDuplicate(name) {
      for (const lbl of labels) {
        const s = strSim(lbl, name);
        if (s >= T_HIGH) return true;
      }
      return false;
    }
    out.top  = out.top.filter(s => !isDuplicate(s.name));
    out.more = out.more.filter(s => !isDuplicate(s.name));
    return out;
  };



  console.info('[KB] v2 matcher/prune enabled (T_HIGH=' + T_HIGH + ', T_MED=' + T_MED + ', minScore=' + MIN_SCORE + ')');
})();

})();
