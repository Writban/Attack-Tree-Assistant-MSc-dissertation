window.Utils = (() => {
  const clamp01 = v => Math.max(0, Math.min(1, +v || 0));
  const debounce = (fn, ms = 180) => {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };
  const saveFile = (name, blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name; a.click(); URL.revokeObjectURL(a.href);
  };
  return { clamp01, debounce, saveFile };
})();

// Keep the optional AI layer separate from the dissertation assistant code.
// Loading it here avoids changing the existing tab/core implementation.
(() => {
  if (document.querySelector('script[data-kb-ai-loader]')) return;
  const script = document.createElement('script');
  script.src = 'js/kb-ai.js';
  script.async = false;
  script.dataset.kbAiLoader = '1';
  script.onerror = () => console.warn('[kb-ai] optional AI layer failed to load');
  document.head.appendChild(script);
})();
