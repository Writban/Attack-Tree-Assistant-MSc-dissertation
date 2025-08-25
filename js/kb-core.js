window.KB = window.KB || {};
KB.core = (() => {
  const state = {
    cfg: null,
    kb: [],
    indices: null,
    log: []
  };

  // Config loader
  async function loadConfig() {
    try {
      const r = await fetch('data/config.json?v=' + Date.now(), { cache: 'no-store' });
      state.cfg = await r.json();
      console.info('[KB] config loaded', state.cfg);
    } catch (e) {
      console.warn('[KB] config missing, using defaults', e);
      state.cfg = {
        experiment: { mode: 'kb', scenario: 'auth' },
        matching: { minScore: 0.45, fuzzyThreshold: 0.86, weights: { exact:1, alias:0.92, keyword:0.62, regex:0.75, fuzzy:0.52, contextBonus:0.2, parentBonus:0.15 }, normalizers:{lowercase:true,stripPunctuation:true,collapseWhitespace:true,removeStopwords:true}, stopwords:["a","an","and","as","at","be","by","for","from","in","into","is","it","its","of","on","or","that","the","their","to","with","via","over"], maxReturned: 10 },
        pruning: { flagThreshold: 0.45, contextMismatchPenalty: 0.2, weights: { likelihood:0.5, impact:0.4, cost:-0.1 } },
        logging: { enabled: true, maxEntries: 5000 },
        woz: { enabled:false, remoteUrl:'woz/feed.auth.json', pollMs:4000, maxBackoffMs:60000 },
        ui: { debounceMs: 180 }
      };
    }
    document.dispatchEvent(new CustomEvent('kb:config:ready', { detail: state.cfg }));
  }

  // KB loader
async function loadKB() {
  try {
    const r = await fetch('data/attack_patterns.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    state.kb = await r.json();
  } catch (e) {
    console.warn('[KB] attack_patterns.json not found/invalid. Proceeding with empty KB.', e);
    state.kb = [];
  }
  state.indices = buildIndices(state.kb);
  window.__KB_PATTERNS__ = state.kb; // allow Explain to soft-match by name
  console.info('[KB] patterns loaded:', state.kb.length);
}


  // Logging
  function log(event, payload) {
    if (state.cfg?.logging?.enabled === false) return;
    const max = state.cfg?.logging?.maxEntries || 5000;
    state.log.push({ ts: new Date().toISOString(), event, ...payload });
    if (state.log.length > max) state.log.splice(0, state.log.length - max);
  }
  const getLog = () => state.log.slice();
  const clearLog = () => { state.log.length = 0; };

  // Normalization
  const stripPunct = s => (s || '').replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const collapseWS = s => (s || '').replace(/\s+/g, ' ').trim();
  function normalize(s) {
    let t = '' + (s || '');
    if (state.cfg.matching.normalizers.lowercase) t = t.toLowerCase();
    if (state.cfg.matching.normalizers.stripPunctuation) t = stripPunct(t);
    if (state.cfg.matching.normalizers.collapseWhitespace) t = collapseWS(t);
    return t;
  }
  function tokenize(s) {
    const stop = new Set(state.cfg.matching.stopwords || []);
    return normalize(s).split(' ').filter(Boolean).filter(w => !stop.has(w));
  }

  // Levenshtein similarity
  function lev(a, b) {
    if (a === b) return 0;
    const al = a.length, bl = b.length;
    if (!al) return bl; if (!bl) return al;
    const v0 = Array(bl + 1), v1 = Array(bl + 1);
    for (let j=0;j<=bl;j++) v0[j]=j;
    for (let i=0;i<al;i++) {
      v1[0]=i+1;
      for (let j=0;j<bl;j++) {
        const cost = a[i] === b[j] ? 0 : 1;
        v1[j+1] = Math.min(v1[j]+1, v0[j+1]+1, v0[j]+cost);
      }
      for (let j=0;j<=bl;j++) v0[j]=v1[j];
    }
    return v1[bl];
  }
  const sim = (a,b) => {
    a = normalize(a); b = normalize(b);
    if (!a || !b) return 0;
    const d = lev(a,b);
    return 1 - d / Math.max(a.length, b.length);
  };

  function buildIndices(kb) {
    const aliasIndex = new Map();
    const keywordIndex = new Map();
    const nameIndex = new Map();
    const pats = [];
    for (const p of kb) {
      const id = p.id || p.name;
      const nameNorm = normalize(p.name || id);
      nameIndex.set(nameNorm, id);
      const aliases = (p.aliases || []).map(normalize);
      const keywords = (p.keywords || []).map(normalize);
      const regex = (p.regex || []).map(r => {
        try { return new RegExp(r, 'i'); } catch { return null; }
      }).filter(Boolean);

      for (const a of aliases.flatMap(tokenize)) {
        if (!aliasIndex.has(a)) aliasIndex.set(a, new Set());
        aliasIndex.get(a).add(id);
      }
      for (const k of keywords.flatMap(tokenize)) {
        if (!keywordIndex.has(k)) keywordIndex.set(k, new Set());
        keywordIndex.get(k).add(id);
      }
      pats.push({ id, name: p.name, nameNorm, aliases, keywords, regex, contexts: new Set((p.contexts || []).map(String)), parentsPreferred: (p.preferred_parents || []).map(normalize), meta: p });
    }
    return { aliasIndex, keywordIndex, nameIndex, pats };
  }

  function matchTextToPatterns({ text, contextFlags = new Set(), parentName = '' }) {
    const m = state.cfg.matching, W = m.weights;
    const { aliasIndex, keywordIndex, nameIndex, pats } = state.indices;
    const tokens = tokenize(text); const parentNorm = normalize(parentName);
    const seen = new Map();

    const add = (id, delta, why) => {
      const acc = seen.get(id) || { id, score: 0, why: [] };
      acc.score += delta; if (why) acc.why.push(why);
      seen.set(id, acc);
    };

    const textNorm = normalize(text);
    if (nameIndex.has(textNorm)) add(nameIndex.get(textNorm), W.exact, `exact "${textNorm}"`);
    for (const t of tokens) {
      const a = aliasIndex.get(t); if (a) for (const id of a) add(id, W.alias*0.5, `alias "${t}"`);
      const k = keywordIndex.get(t); if (k) for (const id of k) add(id, W.keyword*0.5, `keyword "${t}"`);
    }
    for (const p of pats) for (const rx of p.regex) if (rx.test(text)) add(p.id, W.regex, `regex ${rx}`);
    for (const p of pats) {
      const s1 = sim(text, p.name || '');
      if (s1 >= m.fuzzyThreshold) add(p.id, W.fuzzy*s1, `fuzzy name ${s1.toFixed(2)}`);
      for (const a of p.aliases) {
        const s = sim(text, a);
        if (s >= m.fuzzyThreshold) add(p.id, W.fuzzy*s, `fuzzy alias ${s.toFixed(2)}`);
      }
    }
    if (contextFlags && contextFlags.size) {
      for (const p of pats) {
        if (!p.contexts.size) continue;
        const inter = [...p.contexts].some(c => contextFlags.has(c));
        if (inter) add(p.id, W.contextBonus, 'context bonus');
      }
    }
    if (parentNorm) {
      for (const p of pats) {
        if (p.parentsPreferred?.length) {
          const ok = p.parentsPreferred.some(pp => sim(parentNorm, pp) >= 0.9);
          if (ok) add(p.id, W.parentBonus, `parent prefers "${parentNorm}"`);
        }
      }
    }

    const out = [...seen.values()]
      .filter(r => r.score >= m.minScore)
      .sort((a,b) => b.score - a.score)
      .slice(0, m.maxReturned)
      .map(r => {
        const p = pats.find(pp => pp.id === r.id);
        return { id: r.id, name: p?.name || r.id, score:+r.score.toFixed(4), why:r.why, meta: p?.meta || {} };
      });

    log('match', { text: textNorm.slice(0,120), parent: parentNorm, returned: out.length });
    return out;
  }

  function explainFor(meta) {
    const L = Utils.clamp01(meta?.likelihood ?? 0.5);
    const I = Utils.clamp01(meta?.impact ?? 0.5);
    const sev = +(L*I).toFixed(2);
    const band = sev >= 0.75 ? 'High' : sev >= 0.45 ? 'Medium' : 'Low';
    return {
      severity: sev, band,
      lay: meta?.lay_explain || 'This is a way an attacker might progress toward the goal.',
      why: meta?.why_it_matters || 'If present, it increases the chance of compromise.',
      mitigations: meta?.mitigations || []
    };
  }

  function pruneDecision(meta, contextMismatch = false) {
    const W = state.cfg?.pruning?.weights || { likelihood:0.5, impact:0.4, cost:-0.1 };
    const L = Utils.clamp01(meta?.likelihood ?? 0.5);
    const I = Utils.clamp01(meta?.impact ?? 0.5);
    const C = Utils.clamp01(meta?.cost_hint ?? 0.5);
    let score = W.likelihood*L + W.impact*I + W.cost*C;
    if (contextMismatch) score -= (state.cfg?.pruning?.contextMismatchPenalty || 0.2);
    const flag = score < (state.cfg?.pruning?.flagThreshold ?? 0.45);
    const reasons = [];
    if (L < 0.3) reasons.push('Low likelihood here');
    if (C > 0.7) reasons.push('High attacker effort/cost');
    if (contextMismatch) reasons.push('Out of scope');
    return { flag, score:+score.toFixed(4), reasons };
  }

  return {
    loadConfig, loadKB,
    config: () => state.cfg,
    matchTextToPatterns, explainFor, pruneDecision,
    log, getLog, clearLog
  };
})();
