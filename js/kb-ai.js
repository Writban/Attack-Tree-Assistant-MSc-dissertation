// js/kb-ai.js — optional OpenAI-powered recommendations layered under the existing
// Suggest / Review / Explain tools. This file does not replace KB.core logic.
(function () {
  if (!window.KB) window.KB = {};

  const AI = {};
  KB.ai = AI;

  const DEFAULT_API = 'http://localhost:3000/api/ai';

  AI.getEndpoint = function getEndpoint() {
    return window.ATTACK_TREE_AI_API ||
      localStorage.getItem('attackTreeAiApi') ||
      DEFAULT_API;
  };

  AI.setEndpoint = function setEndpoint(url) {
    const clean = String(url || '').trim().replace(/\/$/, '');
    if (!clean) localStorage.removeItem('attackTreeAiApi');
    else localStorage.setItem('attackTreeAiApi', clean);
  };

  function currentSelection() {
    // The toolbar label is the source of truth because app.js also updates it when
    // the user clears a selection. This prevents a stale AI Explain request.
    const text = document.getElementById('sel-label')?.textContent || '';
    const match = text.match(/^Selected:\s*(.+)$/i);
    return match ? match[1].trim() : null;
  }

  function scenarioContext() {
    const session = window.__kbSession || {};
    const raw = window.__scenarioJson || {};

    // Intentionally whitelist only user-visible context. Evaluation answer-key fields
    // such as gold_must_have / gold_low_value are never sent to the AI endpoint.
    return {
      id: session.scenario_id || raw.id || null,
      goal: raw.goal || raw.goalText || null,
      brief: raw.brief || raw.guideText || raw.goal_explain || null
    };
  }

  function treeSnapshot() {
    const graph = window.graph;
    if (!graph) return { nodes: [], edges: [] };

    const nodes = (graph.getElements?.() || []).map((el) => ({
      id: String(el.id),
      label: el.attr?.('label/text') || '',
      gate: el.get?.('gate') || null
    }));

    const edges = (graph.getLinks?.() || []).map((link) => ({
      source: String(link.get('source')?.id || ''),
      target: String(link.get('target')?.id || '')
    })).filter((edge) => edge.source && edge.target);

    return { nodes, edges };
  }

  AI.snapshot = treeSnapshot;

  AI.ask = async function ask(task) {
    const tree = treeSnapshot();
    if (!tree.nodes.length) throw new Error('Add at least one node before asking AI.');

    const selectedNode = currentSelection();
    if (task === 'explain' && !selectedNode) {
      throw new Error('Select a node or gate before asking AI to explain it.');
    }

    const response = await fetch(AI.getEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task,
        selectedNode,
        scenario: scenarioContext(),
        tree
      })
    });

    let data = null;
    try { data = await response.json(); } catch {}

    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || `AI request failed (${response.status}).`);
    }
    return data;
  };

  function actionLabel(action) {
    return ({
      suggest: 'Suggested addition',
      prune: 'Consider pruning',
      keep: 'Keep',
      revise: 'Revise',
      explain: 'Explanation'
    })[action] || String(action || 'Recommendation');
  }

  function appendText(parent, tag, text, className) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = text;
    parent.appendChild(el);
    return el;
  }

  function renderResult(resultBox, data) {
    resultBox.innerHTML = '';

    if (data.summary) appendText(resultBox, 'div', data.summary, 'small');

    const recommendations = Array.isArray(data.recommendations) ? data.recommendations : [];
    if (!recommendations.length) {
      appendText(resultBox, 'div', 'AI did not identify an additional recommendation.', 'small muted');
      return;
    }

    const list = document.createElement('div');
    list.className = 'list';

    recommendations.forEach((rec) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.style.alignItems = 'flex-start';

      const left = document.createElement('div');
      left.style.flex = '1';

      const title = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = rec.title || 'AI recommendation';
      title.appendChild(strong);

      const meta = document.createElement('span');
      meta.className = 'small muted';
      const pct = Math.round(Math.max(0, Math.min(1, Number(rec.confidence) || 0)) * 100);
      meta.textContent = ` · ${actionLabel(rec.action)} · ${pct}% confidence`;
      title.appendChild(meta);

      left.appendChild(title);
      appendText(left, 'div', rec.reason || '', 'small');
      row.appendChild(left);
      list.appendChild(row);
    });

    resultBox.appendChild(list);
  }

  function makeAiCard(task) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.aiRecommendation = task;

    appendText(card, 'div', 'AI recommendation', 'title');

    const help = ({
      suggest: 'Ask AI for a separate, contextual completeness check. Your normal suggestions above are unchanged.',
      prune: 'Ask AI for a separate semantic review of the current tree. Nothing is removed automatically.',
      explain: 'Ask AI for a contextual plain-English explanation of the selected item. The normal explanation above is unchanged.'
    })[task];
    appendText(card, 'div', help, 'small muted');

    const controls = document.createElement('div');
    controls.style.marginTop = '8px';

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Ask AI';
    controls.appendChild(button);
    card.appendChild(controls);

    const resultBox = document.createElement('div');
    resultBox.style.marginTop = '8px';
    card.appendChild(resultBox);

    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Analysing…';
      resultBox.innerHTML = '';
      appendText(resultBox, 'div', 'Sending the current tree for AI review…', 'small muted');

      try {
        const data = await AI.ask(task);
        renderResult(resultBox, data);
        try { KB.core?.log?.('ai_recommendation_shown', { task, count: data.recommendations?.length || 0 }); } catch {}
      } catch (error) {
        resultBox.innerHTML = '';
        appendText(resultBox, 'div', error?.message || 'AI request failed.', 'small');
        if (AI.getEndpoint().startsWith('http://localhost')) {
          appendText(resultBox, 'div', 'Local mode: make sure the server in /server is running on port 3000.', 'small muted');
        }
        console.warn('[kb-ai]', error);
      } finally {
        button.disabled = false;
        button.textContent = 'Ask AI';
      }
    });

    return card;
  }

  const TAB_TASKS = [
    ['tab-suggest', 'suggest'],
    ['tab-review', 'prune'],
    ['tab-explain', 'explain']
  ];

  function ensureSections() {
    for (const [tabId, task] of TAB_TASKS) {
      const tab = document.getElementById(tabId);
      if (!tab) continue;
      if (tab.querySelector(`[data-ai-recommendation="${task}"]`)) continue;
      tab.appendChild(makeAiCard(task));
    }
  }

  document.addEventListener('kb:canvas:ready', () => {
    ensureSections();
  });

  function startObserver() {
    ensureSections();
    const panel = document.getElementById('kb-panel');
    if (!panel) return;

    const observer = new MutationObserver(() => ensureSections());
    observer.observe(panel, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver, { once: true });
  } else {
    startObserver();
  }
})();
