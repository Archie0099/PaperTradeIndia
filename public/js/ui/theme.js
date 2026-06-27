// ---------------------------------------------------------------------------
// ui/theme.js
// Light/dark theme toggle. Dark is the default (defined in :root); the light
// theme overrides the colour variables via [data-theme="light"] on <html>. The
// canvas charts read the same CSS variables, so they follow the theme too.
// The choice persists in localStorage.
// ---------------------------------------------------------------------------

const THEME_KEY = 'paper-trade-india:theme';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
}

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

// Read the saved theme, apply it, and wire the toggle button. `onChange` (if
// given) is called after a toggle so the caller can redraw the canvas charts.
function initTheme(onChange) {
  let saved = 'dark';
  try {
    saved = localStorage.getItem(THEME_KEY) || 'dark';
  } catch {}
  applyTheme(saved);

  const btn = document.getElementById('btn-theme');
  if (!btn) return;
  const sync = () => {
    btn.textContent = currentTheme() === 'light' ? '☾ Dark' : '☀ Light';
  };
  sync();
  btn.addEventListener('click', () => {
    const next = currentTheme() === 'light' ? 'dark' : 'light';
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {}
    sync();
    if (onChange) onChange(next);
  });
}

export { initTheme, applyTheme, currentTheme };
