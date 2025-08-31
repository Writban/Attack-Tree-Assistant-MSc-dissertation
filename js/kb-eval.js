// js/kb-eval.js — Objective scoring of the current tree against the chosen scenario.
// Produces a 0–100 score with a transparent breakdown.
// Depends only on jointjs graph + scenario JSON (goal/gold_must_have/gold_low_value/aliases).

(function () {
  if (!window.KB) window.KB = {};
  const EVAL = {};
  KB.eval = EVAL;

  // --- tunables ---
  const T_MATCH = 0.72;  // token-level Jaccard threshold to consider "same concept"
  const W = {             // weights for the 0–100 score
    coverage: 50,         // must-have coverage carries half the score
    structure: 20,        // connectivity, gate health, depth
    duplicates: 15,       // subtract for near-duplicate nodes
    lowValue: 15          // subtract for known low-value items present
  };

  // --- helpers: text normalization & similarity ---
  const STOP = new Set('a,an,and,or,of,to,in,on,for,with,by,the,as,be,is,are,was,were,then,than,from,into,at,via,after,before,this,that,these,those,any,all,can,may'.split(','));
  function norm(s) {
    return String(s || '').toLowerCase()
      .replace(/[^a-z0-9\s]+/g, ' ')     // strip punctuation
      .replace(/\s+/g, ' ')              // collapse spaces
      .trim();
  }
  function tokens(s) {
    return norm(s).split(' ').filter(t => t && !STOP.has(t));
  }
  function jaccard(a, b) {
    const A = new Set(a), B = new Set(b);
    let inter = 0; for (const x of A) if (B.has(x)) inter++;
    const uni = A.size + B.size - inter;
    return uni ? inter / uni : 0;
  }
  function simLabel(a, b) {
    return jaccard(tokens(a), tokens(b));
  }

  // Expand a gold phrase to {canonical + aliases[]} from scenario aliases
  function expandAliases(phrase, aliasesMap) {
    const list = [phrase];
    const al = aliasesMap && aliasesMap[phrase];
    if (Array.isArray(al)) for (const p of al) list.push(p);
    return list;
  }

  // Return best matching gold phrase (or null) for a given node label
  function bestMatch(label, goldList, aliasesMap) {
    let best = { score: 0, gold: null, alias: null };
    for (const gold of goldList) {
      const cands = expandAliases(gold, aliasesMap);
      for (const cand of cands) {
        const s = simLabel(label, cand);
        if (s > best.score) best = { score: s, gold, alias: cand };
      }
    }
    return (best.score >= T_MATCH) ? best : null;
  }

  // Duplicate clustering by simple greedy thresholding
  function findDuplicates(labels) {
    const N = labels.length;
    const used = new Array(N).fill(false);
    const clusters = [];
    for (let i = 0; i < N; i++) {
      if (used[i]) continue;
      const base = labels[i];
      const cluster = [i];
      used[i] = true;
      for (let j = i + 1; j < N; j++) {
        if (used[j]) continue;
        if (simLabel(base, labels[j]) >= T_MATCH) {
          used[j] = true;
          cluster.push(j);
        }
      }
      if (cluster.length > 1) clusters.push(cluster);
    }
    return clusters; // array of index arrays
  }

  // Structure metrics (connectivity/gates/depth)
  function structureStats(graph, goalLabel) {
    const elements = graph.getElements?.() || [];
    const links = graph.getLinks?.() || [];
    const nodes = elements.length;
    const edges = links.length;

    // undirected adjacency for reachability
    const idIndex = new Map(elements.map((e, i) => [e.id, i]));
    const adj = Array.from({ length: nodes }, () => []);
    for (const l of links) {
      const s = l.get('source'), t = l.get('target');
      const si = s && s.id ? idIndex.get(s.id) : null;
      const ti = t && t.id ? idIndex.get(t.id) : null;
      if (si != null && ti != null) {
        adj[si].push(ti); adj[ti].push(si);
      }
    }

    // pick root: goal if present else highest-degree
    let rootIdx = 0;
    if (goalLabel) {
      const idx = elements.findIndex(e => (e.attr?.('label/text') || '').trim().toLowerCase() === goalLabel.trim().toLowerCase());
      if (idx >= 0) rootIdx = idx;
    } else {
      let bestDeg = -1;
      elements.forEach((e, i) => { if (adj[i].length > bestDeg) { bestDeg = adj[i].length; rootIdx = i; } });
    }

    // BFS for reachability and depth
    const seen = new Array(nodes).fill(false);
    const dist = new Array(nodes).fill(Infinity);
    const q = [rootIdx]; seen[rootIdx] = true; dist[rootIdx] = 0;
    while (q.length) {
      const v = q.shift();
      for (const w of adj[v]) if (!seen[w]) { seen[w] = true; dist[w] = dist[v] + 1; q.push(w); }
    }
    const connected = seen.filter(Boolean).length;
    const connectedPct = nodes ? connected / nodes : 1;
    const maxDepth = dist.reduce((m, d) => isFinite(d) ? Math.max(m, d) : m, 0);

    // gate health
    let andCount = 0, orCount = 0, andOK = 0, orOK = 0;
    elements.forEach((el, i) => {
      const g = el.get?.('gate');
      if (!g) return;
      const deg = adj[i].length;
      if (g === 'AND') { andCount++; if (deg >= 2) andOK++; }
      if (g === 'OR')  { orCount++;  if (deg >= 2) orOK++; }
    });
    const validAndPct = andCount ? andOK / andCount : 1;
    const validOrPct  = orCount ? orOK / orCount : 1;

    return {
      nodes, edges, connectedPct, maxDepth,
      gates: { andCount, orCount, validAndPct, validOrPct }
    };
  }

  // Main evaluation
  EVAL.evaluate = function evaluate(graph, scenarioObj) {
    try {
      const scen = scenarioObj || window.__scenarioJson || {};
      const must = Array.isArray(scen.gold_must_have) ? scen.gold_must_have : [];
      const lowv = Array.isArray(scen.gold_low_value) ? scen.gold_low_value : [];
      const nice = Array.isArray(scen.gold_nice_to_have) ? scen.gold_nice_to_have : []; // optional
      const aliases = scen.aliases || {};

      // Gather labels from the current graph
      const els = graph.getElements?.() || [];
      const labels = els.map(e => e.attr?.('label/text') || '').filter(Boolean);

      // Coverage: match must & nice
      const matchedMust = new Set();
      const matchedNice = new Set();
      const label2must  = new Map();
      const label2nice  = new Map();

      labels.forEach(lbl => {
        const m = bestMatch(lbl, must, aliases);
        if (m) { matchedMust.add(m.gold); label2must.set(lbl, m.gold); }
        const n = nice.length ? bestMatch(lbl, nice, aliases) : null;
        if (n) { matchedNice.add(n.gold); label2nice.set(lbl, n.gold); }
      });

      const mustHaveHit = matchedMust.size;
      const mustHaveTot = must.length;
      const niceHaveHit = matchedNice.size;
      const niceHaveTot = nice.length;

      // Low-value penalties present
      let lowValueHits = 0;
      const lowValueMatched = [];
      labels.forEach(lbl => {
        const lv = lowv.length ? bestMatch(lbl, lowv, aliases) : null;
        if (lv) { lowValueHits++; lowValueMatched.push({ label: lbl, hit: lv.gold }); }
      });

      // Duplicate clusters
      const dupClusters = findDuplicates(labels);
      const dupCount = dupClusters.reduce((s, c) => s + (c.length - 1), 0);

      // Structure
      const S = structureStats(graph, scen.goal);

      // ---- scoring (0–100) ----
      // Coverage subscore: must-have coverage (primary) + 25% credit for nice-to-have
      const covMust = mustHaveTot ? (mustHaveHit / mustHaveTot) : 1;
      const covNice = niceHaveTot ? (niceHaveHit / niceHaveTot) : 0;
      const coverageSub = Math.max(0, Math.min(1, 0.85 * covMust + 0.15 * covNice)); // bounded

      // Structure subscore combines connectivity, gate sanity, and depth ≥ 2 (scaled)
      const depthOK = S.maxDepth >= 2 ? 1 : (S.maxDepth / 2); // 0..1
      const structSub = clamp01(0.5 * S.connectedPct + 0.25 * S.gates.validAndPct + 0.15 * S.gates.validOrPct + 0.10 * depthOK);

      // Duplicate penalty: scale down from 1 as duplicates grow (relative to nodes)
      const dupRate = (S.nodes > 0) ? (dupCount / S.nodes) : 0;
      const dupSub = clamp01(1 - Math.min(1, 1.5 * dupRate)); // more duplicates => lower

      // Low-value penalty: each hit subtracts a step; 0 hits => 1, 1 => ~0.7, 2+ => down to 0.4, floor at 0
      const lvSub = clamp01(1 - Math.min(1, 0.3 * lowValueHits));

      const score = {
        coverage: Math.round(W.coverage * coverageSub),
        structure: Math.round(W.structure * structSub),
        duplicates: Math.round(W.duplicates * dupSub),
        lowValue: Math.round(W.lowValue * lvSub)
      };
      score.overall = Math.max(0, Math.min(100, score.coverage + score.structure + score.duplicates + score.lowValue));

      return {
        score, // integers per band + overall 0–100
        coverage: {
          mustHaveTot, mustHaveHit, niceHaveTot, niceHaveHit,
          matchedMust: Array.from(matchedMust),
          missedMust: must.filter(m => !matchedMust.has(m))
        },
        structure: S,
        penalties: {
          lowValueHits, lowValueMatched, duplicateClusters: dupClusters, duplicateCount: dupCount
        },
        matched: {
          label2must: Array.from(label2must.entries()),
          label2nice: Array.from(label2nice.entries())
        }
      };
    } catch (e) {
      console.error('[eval] failed:', e);
      return { score: { coverage:0, structure:0, duplicates:0, lowValue:0, overall:0 } };
    }
  };

  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
})();
