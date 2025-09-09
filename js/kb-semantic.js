// js/kb-semantic.js — semantic fallback using Universal Sentence Encoder
(function () {
  if (!window.KB) window.KB = {};
  const SEM = {};
  KB.sem = SEM;

  let model = null;
  let INDEX = null; // [{ id, text, vec: Float32Array }]
  let ID_LIST = null;

  function cfg() {
    try { return (KB.core.getConfig && KB.core.getConfig()) || {}; } catch { return {}; }
  }
  function semCfg() { return (cfg().matching && cfg().matching.semantic) || {}; }
  function semEnabled() { return !!semCfg().enabled; }
  function threshold() { const t = semCfg().threshold; return (typeof t === 'number') ? t : 0.6; }
  function topK() { const k = semCfg().topK; return (typeof k === 'number') ? k : 3; }

  async function ensureModel() {
    if (model) return model;
    if (!window.use || !window.tf) throw new Error('USE/TensorFlow missing');
    model = await use.load();
    return model;
  }

  function kbEntries() {
    try {
      // BY_ID is inside kb-core.js closure; expose via KB.core if needed.
      // We derive from the public KB.core API by asking for suggestions over BY_ID map indirectly:
      const all = (KB.core._allEntries && KB.core._allEntries()) || null;
      if (all) return all;
    } catch {}
    // Fallback: reconstruct from explainables via names we can resolve
    // We rely on KB.core exposing names in attack_patterns.json already loaded.
    const raw = [];
    try {
      const byId = KB.core._byId && KB.core._byId();
      if (byId) {
        byId.forEach((e, id) => raw.push({ id, e }));
        return raw;
      }
    } catch {}
    // Minimal route: ask core for IDs via suggest’s COMMON_IDS would be incomplete—so we read the global that kb-core placed:
    try { return (window.__KB_ALL || []).map(x => ({ id: x.id, e: x })); } catch {}
    return [];
  }

  function entryToText(e) {
    const name = e.name || e.id || '';
    const aliases = Array.isArray(e.aliases) ? e.aliases.join(' ; ') : '';
    const lay = e.lay_explain || '';
    const desc = e.description || e.comms || e.why || '';
    return [name, aliases, lay, desc].filter(Boolean).join(' | ');
  }

  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { const x = a[i], y = b[i]; dot += x*y; na += x*x; nb += y*y; }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
  }

  async function ensureIndex() {
    if (INDEX) return;
    await ensureModel();
    // Build once: embed all KB entries
    const rows = [];
    const all = kbEntries();
    ID_LIST = all.map(r => r.id);
    const texts = all.map(r => entryToText(r.e));
    const emb = await model.embed(texts); // [N, 512]
    const arr = await emb.array();
    INDEX = ID_LIST.map((id, i) => ({ id, text: texts[i], vec: Float32Array.from(arr[i]) }));
    emb.dispose && emb.dispose();
  }

  SEM.ready = async function ready() {
    if (!semEnabled()) return false;
    try { await ensureIndex(); return true; } catch { return false; }
  };

  SEM.best = async function best(query, k, minScore) {
    if (!semEnabled() || !query) return null;
    await ensureIndex();
    const m = await ensureModel();
    const q = await m.embed([String(query)]);
    const vec = Float32Array.from((await q.array())[0]);
    q.dispose && q.dispose();

    let scored = INDEX.map(row => ({ id: row.id, score: cosine(vec, row.vec) }));
    scored.sort((a,b) => b.score - a.score);
    const top = scored.slice(0, typeof k === 'number' ? k : topK());
    const t = (typeof minScore === 'number') ? minScore : threshold();
    const best = top.find(x => x.score >= t) || top[0] || null;
    return best && best.score >= t ? best : null;
  };

  // Optional: expose a small batch API for later (review/suggest boosts)
  SEM.topK = async function topKMatches(query, k) {
    if (!semEnabled() || !query) return [];
    await ensureIndex();
    const m = await ensureModel();
    const q = await m.embed([String(query)]);
    const vec = Float32Array.from((await q.array())[0]);
    q.dispose && q.dispose();
    let scored = INDEX.map(row => ({ id: row.id, score: cosine(vec, row.vec) }));
    scored.sort((a,b) => b.score - a.score);
    const K = typeof k === 'number' ? k : topK();
    return scored.slice(0, K);
  };
})();
