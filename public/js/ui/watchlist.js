// ---------------------------------------------------------------------------
// ui/watchlist.js
// The left-rail watchlist: MULTIPLE named lists (switch / create / delete),
// each a set of symbols with live LTP and % change. Clicking a row makes it the
// "active symbol" (loads its chart + pre-fills the ticket). Everything persists
// in localStorage; an older single-list save is migrated automatically.
// ---------------------------------------------------------------------------

import { $, el, clear, fmt, signed, moveClass } from './dom.js';

const LISTS_KEY = 'paper-trade-india:watchlists'; // { lists: {name:[..]}, active }
const LEGACY_KEY = 'paper-trade-india:watchlist'; // old single-array format
const DEFAULT_WATCH = ['NIFTY', 'BANKNIFTY', 'RELIANCE', 'TCS', 'INFY'];

// Module-level state: the named lists and which one is active.
let wl = { lists: { Default: [...DEFAULT_WATCH] }, active: 'Default' };

function loadState() {
  // New multi-list format.
  try {
    const raw = localStorage.getItem(LISTS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object' && p.lists && typeof p.lists === 'object' && !Array.isArray(p.lists)) {
        // Null-prototype map so list names that collide with Object.prototype
        // members (constructor, toString, hasOwnProperty, …) work normally.
        const lists = Object.create(null);
        for (const name of Object.keys(p.lists)) {
          if (Array.isArray(p.lists[name])) lists[name] = p.lists[name].filter((s) => typeof s === 'string');
        }
        if (Object.keys(lists).length) {
          const active = lists[p.active] ? p.active : Object.keys(lists)[0];
          return { lists, active };
        }
      }
    }
  } catch {}
  // Migrate the legacy single list (or fall back to the defaults).
  let migrated = [...DEFAULT_WATCH];
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const arr = JSON.parse(legacy);
      if (Array.isArray(arr)) migrated = arr.filter((s) => typeof s === 'string');
    }
  } catch {}
  const lists = Object.create(null);
  lists.Default = migrated;
  return { lists, active: 'Default' };
}

function persist() {
  try {
    localStorage.setItem(LISTS_KEY, JSON.stringify(wl));
  } catch {}
}

function initWatchlist(app) {
  wl = loadState();
  app.state.watch = wl.lists[wl.active];

  renderSelector();

  $('#watch-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#watch-input');
    const sym = input.value.trim().toUpperCase();
    const list = wl.lists[wl.active];
    if (sym && !list.includes(sym)) {
      list.push(sym);
      app.state.watch = list;
      persist();
      input.value = '';
      renderWatchlist(app);
      app.pollQuotes(); // fetch the new symbol immediately
    }
  });

  $('#watchlist-select').addEventListener('change', () => switchList(app, $('#watchlist-select').value));
  $('#btn-new-watchlist').addEventListener('click', () => newList(app));
  $('#btn-del-watchlist').addEventListener('click', () => deleteList(app));
}

function switchList(app, name) {
  if (!wl.lists[name]) return;
  wl.active = name;
  app.state.watch = wl.lists[name];
  persist();
  renderSelector();
  renderWatchlist(app);
  app.pollQuotes();
}

function newList(app) {
  const name = (prompt('New watchlist name:') || '').trim();
  if (!name || wl.lists[name]) return;
  wl.lists[name] = [];
  wl.active = name;
  app.state.watch = wl.lists[name];
  persist();
  renderSelector();
  renderWatchlist(app);
}

function deleteList(app) {
  if (Object.keys(wl.lists).length <= 1) return; // always keep at least one list
  delete wl.lists[wl.active];
  wl.active = Object.keys(wl.lists)[0];
  app.state.watch = wl.lists[wl.active];
  persist();
  renderSelector();
  renderWatchlist(app);
  app.pollQuotes();
}

function renderSelector() {
  const sel = $('#watchlist-select');
  if (!sel) return;
  clear(sel);
  for (const name of Object.keys(wl.lists)) sel.append(el('option', { value: name }, name));
  sel.value = wl.active;
}

function renderWatchlist(app) {
  const container = $('#watchlist');
  // Remember which row (by symbol) holds keyboard focus BEFORE we tear the list
  // down, so the periodic 5s refresh (pollQuotes -> renderWatchlist) doesn't
  // yank focus away mid-interaction. Restored at the end if the row survives.
  const active = document.activeElement;
  const focusedRow = active && active.closest ? active.closest('.watch-item') : null;
  const focusedSym = focusedRow ? focusedRow.getAttribute('data-symbol') : null;

  const root = clear(container);
  if (app.state.watch.length === 0) {
    root.append(el('div', { class: 'empty-state' }, 'No symbols. Add one above.'));
    return;
  }
  for (const sym of app.state.watch) {
    const q = app.state.quotes[sym];
    const chg = q ? q.changePct : null;
    // Show the ABSOLUTE ₹ change next to the %. The ₹ change is
    // shown only when the quote carries it; with just a % we show the % alone.
    const hasAbs = q && q.change != null && Number.isFinite(q.change);
    const chgText = chg == null ? '' : (hasAbs ? `${signed(q.change)}  ${signed(chg)}%` : `${signed(chg)}%`);
    const row = el('div', { class: 'watch-item', tabindex: '0', role: 'button', 'data-symbol': sym }, [
      el('div', { class: 'w-main' }, [el('span', { class: 'w-sym' }, sym)]),
      el('div', { class: 'w-quote' }, [
        el('span', { class: 'w-ltp' }, q ? fmt(q.ltp) : '…'),
        el('span', { class: 'w-chg ' + moveClass(chg) }, chgText),
      ]),
    ]);
    // Click row -> set active symbol. Click the × -> remove from the active list.
    row.addEventListener('click', () => app.setActiveSymbol(sym));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        app.setActiveSymbol(sym);
      }
    });
    const remove = el('button', { class: 'w-remove', title: 'Remove', 'aria-label': `Remove ${sym}` }, '×');
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      const list = wl.lists[wl.active].filter((s) => s !== sym);
      wl.lists[wl.active] = list;
      app.state.watch = list;
      persist();
      renderWatchlist(app);
    });
    row.append(remove);
    root.append(row);
  }

  // Restore keyboard focus to the same symbol's row if it survived the rebuild.
  // Iterate + compare (not a querySelector) so a symbol containing a quote can't
  // produce an invalid selector.
  if (focusedSym) {
    const again = [...container.querySelectorAll('.watch-item')].find((r) => r.getAttribute('data-symbol') === focusedSym);
    if (again) again.focus();
  }
}

export { initWatchlist, renderWatchlist };
