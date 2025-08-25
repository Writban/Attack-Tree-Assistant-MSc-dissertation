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
