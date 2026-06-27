// ---------------------------------------------------------------------------
// ui/tabs.js
// Switches between the main workspace tabs (Positions / Option Chain /
// Strategy Builder / Orders). Calls an optional onShow callback so a tab can
// refresh itself the moment it becomes visible.
// ---------------------------------------------------------------------------

import { $, $$ } from './dom.js';

function initTabs(onShow) {
  const buttons = $$('.nav-btn');
  const panels = $$('.tab-panel');

  function show(name) {
    buttons.forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    panels.forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
    if (onShow) onShow(name);
  }

  buttons.forEach((btn) => btn.addEventListener('click', () => show(btn.dataset.tab)));

  // Expose programmatic switching (used when "trade" is clicked elsewhere).
  return { show };
}

export { initTabs };
