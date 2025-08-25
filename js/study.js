(function () {
  let cfg = null;

  document.addEventListener('kb:config:ready', (e) => {
    cfg = e.detail;
    const chip = document.getElementById('study-toolbar');
    const showChip = (cfg?.experiment?.mode || 'kb') !== 'baseline';
    if (showChip) chip.classList.remove('hidden');
    document.getElementById('study-mode').textContent = `mode: ${cfg?.experiment?.mode || 'kb'}`;
    document.getElementById('study-scenario').textContent = `scenario: ${cfg?.experiment?.scenario || 'auth'}`;
  });

  document.getElementById('btn-download-log').addEventListener('click', () => {
    const lines = (KB.core.getLog() || []).map(o => JSON.stringify(o) + '\n');
    const blob = new Blob(lines, { type: 'application/x-ndjson' });
    Utils.saveFile(`kb_session_${new Date().toISOString().replace(/[:.]/g,'-')}.jsonl`, blob);
    KB.core.log('log_downloaded', { count: lines.length });
  });
})();
