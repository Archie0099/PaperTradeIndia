// ---------------------------------------------------------------------------
// ui/shortcuts.js
// Keyboard shortcuts for fast navigation:
//   1 / 2 / 3 / 4 / 5 -> Positions / Option Chain / Strategy / Orders / Tournament
//   /                 -> focus the watchlist "add symbol" box
// Shortcuts are ignored while typing in a field (so they never hijack input).
// ---------------------------------------------------------------------------

const TAB_KEYS = { 1: 'dashboard', 2: 'chain', 3: 'strategy', 4: 'orders', 5: 'tournament' };

function initShortcuts(app) {
  document.addEventListener('keydown', (e) => {
    // Don't hijack typing or modified chords.
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const tab = TAB_KEYS[e.key];
    if (tab && app.tabs) {
      app.tabs.show(tab);
      e.preventDefault();
      return;
    }
    if (e.key === '/') {
      const input = document.getElementById('watch-input');
      if (input) {
        input.focus();
        e.preventDefault();
      }
    }
  });
}

export { initShortcuts };
