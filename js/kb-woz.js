window.KB = window.KB || {};
KB.woz = (() => {
  let cfg = null, feed = null, timer = null, backoff = 0, selParent = '';

  document.addEventListener('kb:config:ready', (e) => { cfg = e.detail; if (cfg?.woz?.enabled) start(); });
  document.addEventListener('kb:selection', (e) => { selParent = (e.detail?.parent || '').toLowerCase(); });

  async function start(){ await pollOnce(); schedule(); }
  function schedule(){
    const base = cfg?.woz?.pollMs || 4000, jitter = Math.floor(Math.random()*500);
    const delay = Math.min(base + backoff + jitter, cfg?.woz?.maxBackoffMs || 60000);
    clearTimeout(timer); timer = setTimeout(pollOnce, delay);
  }
  async function pollOnce(){
    try {
      const r = await fetch(cfg.woz.remoteUrl + '?t=' + Date.now(), { cache:'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      feed = await r.json(); backoff = 0; KB.core.log('woz_feed', { entries: feed?.entries?.length || 0 });
    } catch (e) { backoff = Math.min(backoff*2 + 500, cfg?.woz?.maxBackoffMs || 60000); KB.core.log('woz_error', { msg: String(e) }); }
    finally { schedule(); }
  }

  function merge(results, ctx) {
    if (!cfg?.woz?.enabled || !feed?.entries?.length) return results;
    const arr = results.slice();
    for (const ent of feed.entries) {
      if (feed.scenario && ctx?.scenarioId && feed.scenario !== ctx.scenarioId) continue;
      const want = (ent.when?.selected_parent_alias || '').toLowerCase();
      const got  = (ctx?.selectedParent || selParent || '').toLowerCase();
      if (want && !got.includes(want)) continue;

      const name = (ent.what?.text || '').toLowerCase();
      if (!name) continue;
      const i = arr.findIndex(r => (r.name || r.id).toLowerCase() === name);
      if (i === -1) {
        arr.push({ id: ent.id || ('woz:'+Math.random().toString(36).slice(2)), name: ent.what.text, score: (ent.what.score_boost || 0.3), why: ent.what.why || ['boosted'], meta:{} });
      } else {
        arr[i].score += (ent.what.score_boost || 0.3);
        arr[i].why.push('boosted');
      }
    }
    arr.sort((a,b)=>b.score-a.score);
    return arr.slice(0, (KB.core.config()?.matching?.maxReturned) || 10);
  }

  return { merge };
})();
