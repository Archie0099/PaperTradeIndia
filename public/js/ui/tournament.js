// ---------------------------------------------------------------------------
// ui/tournament.js
// The Tournament tab: a live leaderboard of the autonomous paper-trading bots
// (GET /api/tournament), an "equity race" chart (click a bot to highlight), a
// detail card explaining the selected strategy in plain English, an evolution
// history log, and a control panel (Add / Evolve / Reset / remove a bot).
// Read-only display of VIRTUAL-money bots running on the server.
// ---------------------------------------------------------------------------

import { $, el, clear, rupee, fmt, signed, moveClass } from './dom.js';
import { drawMultiLine, drawLineChart } from './chart.js';
import { windowed, windowMsOf, spanOf, windowButtons, effectiveWindow, axisIntervalForSpan } from './chartwindow.js';
import { showToast } from './alerts.js';

let selectedId = null;
let lastData = null;
let wired = false;
// Visible time-window per chart (module-level so the choice SURVIVES the 30s poll re-render).
// 'MAX' = the whole life (the default). See ui/chartwindow.js.
let raceWindow = 'MAX'; // the leaderboard equity-race chart
let botpageWindow = 'MAX'; // the per-bot detail-page equity curve
// Format a return % for the leaderboard. Over a ~20-year track, Track % can be 4-5 digits
// (e.g. +10,459%), where 2 decimals are just noise — so we taper the precision with the
// magnitude: 0 dp ≥ 1000%, 1 dp ≥ 100%, else 2 dp. (Live %, today's move, stays at 2 dp.)
const pctReturn = (x) => {
  // null/undefined (a window the bot lacks history for) OR non-finite -> "–", never "–%".
  // NB: must check null BEFORE Number(), since Number(null) === 0 is finite and would slip past.
  if (x == null || !Number.isFinite(Number(x))) return '–';
  const a = Math.abs(Number(x));
  return signed(x, a >= 1000 ? 0 : a >= 100 ? 1 : 2) + '%';
};
// Compact ₹ for the leaderboard equity column. Every bot starts at ₹1cr, and over ~20y a
// big winner reaches ₹100cr+ — an 8-9 digit number that's hard to scan and makes the column
// huge. Show it in CRORES (₹104.6 Cr), the natural unit here, so the multiple-of-capital is
// obvious at a glance. The exact rupee value is kept as the cell tooltip.
const compactCr = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '–';
  const cr = Math.abs(v) / 1e7;
  const dp = cr >= 100 ? 0 : cr >= 10 ? 1 : 2;
  // Decide the sign from the value AFTER rounding to dp, so a tiny-negative equity that
  // rounds to 0.00 never shows a spurious "-" (the -0.00 artifact the project avoids).
  const sign = v < 0 && cr >= 0.5 / 10 ** dp ? '-' : '';
  return sign + '₹' + fmt(cr, dp) + ' Cr';
};

// Read a theme CSS variable (so chart colours follow light/dark), with a fallback.
const cssVar = (name, fb) => {
  try { return (getComputedStyle(document.documentElement).getPropertyValue(name) || '').trim() || fb; } catch { return fb; }
};
// The equity-race line colour per strategy KIND — the SAME hues as the table's kind badges
// (EQ→violet, F&O→accent, BASKET→green/up, PAIRS→red/down), so the chart and the table agree.
const kindColors = () => ({
  BASKET: cssVar('--up', '#22c55e'),
  FNO: cssVar('--accent', '#f0a500'),
  PAIRS: cssVar('--down', '#ef4444'),
  EQ: cssVar('--violet', '#8b7dff'),
});
const KIND_LABEL = { BASKET: 'Basket', FNO: 'F&O', PAIRS: 'Pairs', EQ: 'Equity' };
// A small colour key under the chart: only the kinds actually on the board, with a count.
function renderLegend(node, bots, kc) {
  if (!node) return;
  clear(node);
  const counts = {};
  for (const b of bots) counts[b.kind] = (counts[b.kind] || 0) + 1;
  Object.keys(counts).sort().forEach((k) => {
    node.append(el('span', { class: 'legend-item' }, [
      el('span', { class: 'legend-swatch', style: `background:${kc[k] || 'var(--muted)'}` }),
      el('span', {}, `${KIND_LABEL[k] || k} (${counts[k]})`),
    ]));
  });
}
// Leaderboard sort state (module-level, so it SURVIVES the 30s poll re-render). null =
// the server's default order (Live % desc). A click on a column header sets the key +
// a sensible default direction; clicking the SAME header again flips the direction.
let sortKey = null;
let sortDir = -1; // 1 = ascending, -1 = descending
// Monotonic token for the per-bot detail PAGE fetch, so a slow open for bot A can't
// overwrite a newer open for bot B (the same stale-async guard app.js/optionChain/
// loadBotTrades use). Bumped on every openBotPage; a resolved fetch renders only if
// it's still the latest.
let pageReqId = 0;

const th = (t, title) => el('th', title ? { title } : {}, t);

// Re-order the leaderboard rows by the active sort column. Numeric columns sort by
// value (a non-finite metric sinks to the bottom either way); the text columns
// (Bot/Symbol/Kind) sort alphabetically. With no sort chosen we keep the server's
// order exactly (so the default board is unchanged).
function sortBots(bots) {
  if (!sortKey) return bots;
  const isText = sortKey === 'name' || sortKey === 'symbol' || sortKey === 'kind';
  // A null period return (the bot lacks that much history, shown as "–") must sort to the END,
  // not as 0 — so map null/undefined to NaN (the comparator below sends NaN to -Infinity).
  const val = (b) => {
    if (isText) return String(b[sortKey] || '');
    const v = b[sortKey];
    return v == null ? NaN : Number(v);
  };
  return bots.slice().sort((a, z) => {
    if (isText) return val(a).localeCompare(val(z)) * sortDir;
    const x = val(a), y = val(z);
    // A "–" (no-history) row always sorts to the END — in BOTH directions, not just descending.
    const xBad = !Number.isFinite(x), yBad = !Number.isFinite(y);
    if (xBad || yBad) return xBad && yBad ? (a.name || '').localeCompare(z.name || '') : (xBad ? 1 : -1);
    return (x - y) * sortDir || (a.name || '').localeCompare(z.name || ''); // stable tiebreak
  });
}

// A clickable column header that sorts the leaderboard by `key`. `defaultDir` is the
// direction the FIRST click applies (descending for "higher is better" metrics,
// ascending for MaxDD where lower is better, and for the text columns). The active
// column shows a ▲/▼ arrow; clicking it again toggles the direction.
function sortableTh(label, title, key, defaultDir, app) {
  const active = sortKey === key;
  const arrow = active ? (sortDir === 1 ? ' ▲' : ' ▼') : '';
  const node = el('th', { title: title || '', class: active ? 'sort-active' : null, style: 'cursor:pointer;user-select:none;white-space:nowrap' }, label + arrow);
  node.addEventListener('click', () => {
    if (sortKey === key) sortDir = -sortDir; // same column -> flip direction
    else { sortKey = key; sortDir = defaultDir; }
    render(app, lastData);
  });
  return node;
}

function renderTrades(box, d) {
  clear(box);
  if (!d || d.ok === false) { box.append(el('div', { class: 'muted' }, 'Trade history unavailable.')); return; }
  const trades = d.trades || [];
  box.append(el('div', { style: 'font-weight:600;margin:2px 0 2px' }, `${d.name} — full trade history`));
  const hdr = el('div', { class: 'muted', style: 'margin-bottom:6px' });
  hdr.append(`${d.tradeCount} trade(s)${d.tradeCount > trades.length ? ` · showing the latest ${trades.length}` : ''} · ${d.liveTradeCount || 0} since deployment (live) · net booked P&L `);
  hdr.append(el('span', { class: moveClass(d.totalRealised || 0) }, rupee(d.totalRealised || 0, 0)));
  hdr.append(' (realised on closes)');
  box.append(hdr);
  if (!trades.length) {
    box.append(el('div', { class: 'muted' }, 'No trades yet — this bot has been sitting in cash over its history.'));
    return;
  }
  const table = el('table');
  table.append(el('thead', {}, el('tr', {}, [
    th('#'), th('Date'), th('Stock'), th('Side'), th('Qty'), th('Price'),
    th('Value', 'Cash size of the trade'), th('Booked P&L', 'Realised profit/loss when this trade CLOSED part of a position'),
    th('Reason', 'Why this buy/sell happened'), th(''),
  ])));
  const tbody = el('tbody');
  // Most-recent first, so the bot's latest moves are on top.
  trades.slice().reverse().forEach((tr, i) => {
    const dt = Number.isFinite(tr.t) ? new Date(tr.t).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
    const isSell = /SELL/.test(tr.side);
    const row = el('tr', {}, [
      el('td', { class: 'num muted' }, String(trades.length - i)),
      el('td', {}, dt),
      el('td', {}, tr.symbol),
      el('td', { class: isSell ? 'down' : 'up' }, tr.side),
      el('td', { class: 'num' }, String(tr.qty)),
      el('td', { class: 'num' }, rupee(tr.price, 2)),
      el('td', { class: 'num' }, rupee(tr.value, 0)),
      el('td', { class: 'num ' + (tr.realised ? moveClass(tr.realised) : 'muted') }, tr.realised ? signed(tr.realised, 0) : '—'),
      el('td', { class: 'trade-reason', title: tr.reason || '' }, tr.reason || '—'),
      el('td', { class: 'muted' }, tr.live ? 'live' : ''),
    ]);
    if (tr.live) row.style.boxShadow = 'inset 2px 0 0 var(--accent)'; // mark forward (post-deploy) trades
    tbody.append(row);
  });
  table.append(tbody);
  box.append(el('div', { class: 'table-wrap', style: 'max-height:280px;overflow:auto' }, table));
}

function render(app, data) {
  if (!data) return;
  lastData = data;
  const root = clear($('#tourn-table'));
  const meta = $('#tourn-meta');
  const bots = data.bots || [];

  const evoOff = data.evolutionEnabled === false;
  if (meta) {
    const deployed = data.deployedAt ? new Date(data.deployedAt).toLocaleDateString('en-IN') : '—';
    const cash = data.startingCash ? `₹${data.startingCash.toLocaleString('en-IN')} each` : '';
    // Show how full the (growing) board is, and when grow-mode evolution has paused
    // because it hit the cap — so a user watching the LIVE board (not just the
    // Evolve-click toast) understands why no new bots are appearing. When BREEDING is OFF
    // (the curated-board mode), drop the generation + cap text and just show the bot count.
    const count = data.botCount != null ? data.botCount : (data.bots || []).length;
    const board = evoOff
      ? ` · ${count} bots (curated line-up)`
      : (data.maxBots ? ` · ${count}/${data.maxBots} bots${data.atCap ? ' (full — evolution paused)' : ''}` : '');
    const genPart = evoOff ? '' : `Gen ${data.generation} · `;
    meta.textContent = `${genPart}deployed ${deployed} · ${data.liveBars} forward day(s) · ${cash}${board}`;
  }
  // When breeding is turned off (the curated-board mode), hide BOTH bot-adding controls —
  // "Evolve ⚙" (genetic algorithm) AND "+ Add bot" (inject a generated-pool strategy) — so the
  // board stays purely the curated seed line-up (no auto- OR manually-added non-seed bots).
  const evoBtn = $('#btn-evolve');
  if (evoBtn) evoBtn.hidden = evoOff;
  const addBtn = $('#btn-add-bot');
  if (addBtn) addBtn.hidden = evoOff;
  if (!bots.length) {
    root.append(el('div', { class: 'empty-state' }, 'No bots running.'));
    // Drop EVERY sibling pane the happy path populates — the window buttons (a click would else
    // repaint the stale leaderboard over this empty state), the colour legend, the evolution log,
    // and the race chart itself — so an empty board never sits beside a stale chart/legend/log.
    // For symmetry with the 503-catch; the roster can't actually empty after a populated render
    // today, so this is defensive, but it keeps the two clear-down paths identical.
    const winEl = $('#tourn-chart-windows');
    if (winEl) clear(winEl);
    const legEl = $('#tourn-legend');
    if (legEl) clear(legEl);
    clear($('#tourn-history'));
    drawMultiLine($('#tourn-chart'), [], { emptyMsg: 'No bots running.' });
    return;
  }
  if (!bots.some((b) => b.id === selectedId)) selectedId = bots[0].id;
  // Apply the chosen column sort (a copy — never mutate the server payload). The
  // chart + selection use this same order so everything stays in sync.
  const ordered = sortBots(bots);

  const table = el('table');
  table.append(
    el('thead', {}, el('tr', {}, [
      th('#'),
      sortableTh('Bot', 'Sort by name', 'name', 1, app),
      sortableTh('Symbol', 'Sort by symbol', 'symbol', 1, app),
      sortableTh('Kind', 'Sort by kind (EQ / FNO / BASKET / PAIRS)', 'kind', 1, app),
      sortableTh('1D', "Today's move — the latest session's return, marked-to-market (click to sort)", 'liveReturnPct', -1, app),
      sortableTh('1W', 'Return over the last ~week — as if squared off now vs a week ago (click to sort)', 'r1w', -1, app),
      sortableTh('1M', 'Return over the last ~month, marked-to-market (click to sort)', 'r1m', -1, app),
      sortableTh('1Y', 'Return over the last ~year, marked-to-market (click to sort)', 'r1y', -1, app),
      sortableTh('5Y', 'Return over the last ~5 years (“–” if the bot has less history) (click to sort)', 'r5y', -1, app),
      sortableTh('10Y', 'Return over the last ~10 years (“–” if the bot has less history) (click to sort)', 'r10y', -1, app),
      sortableTh('MAX', "Total return over the bot's WHOLE life — as if held from its first bar to now (click to sort)", 'trackReturnPct', -1, app),
      sortableTh('Sharpe', 'Risk-adjusted return — higher is better (click to sort)', 'sharpe', -1, app),
      sortableTh('MaxDD %', 'Worst peak-to-trough drop — lower is better (click to sort)', 'maxDrawdownPct', 1, app),
      th('Position'),
      sortableTh('Equity', 'Account value (click to sort)', 'equity', -1, app),
      th(''),
    ]))
  );
  const tbody = el('tbody');
  ordered.forEach((b, i) => {
    const removeCell = el('td', {});
    if (!b.protected) {
      const x = el('button', { class: 'btn btn-mini', title: 'Remove this bot' }, '×');
      x.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (x.disabled) return; // guard a fast double-click (a second stale POST)
        x.disabled = true;
        try {
          const r = await app.api.removeTournamentBot(b.id);
          if (r.ok) { showToast(`Removed "${r.removed}"`); render(app, r.standings); }
          else { showToast(r.error || 'Could not remove'); x.disabled = false; }
        } catch (e) { showToast('Remove failed: ' + e.message); x.disabled = false; }
      });
      removeCell.append(x);
    }
    // Kind shown as a colour-coded badge (+ the bar interval for intraday bots).
    const kindBadge = el('span', { class: 'kind-badge ' + b.kind }, b.kind);
    const kindCell = b.interval && b.interval !== '1d'
      ? el('td', {}, [kindBadge, el('span', { class: 'muted', style: 'font-size:10px;margin-left:5px' }, b.interval)])
      : el('td', {}, kindBadge);
    // The Bot cell carries the name + a "›" open-hint (the whole row opens the bot page).
    const nameCell = el('td', {}, [
      el('span', { title: b.note || '' }, b.gen > 0 ? `${b.name}  ·g${b.gen}` : b.name),
      el('span', { class: 'open-hint', style: 'margin-left:7px;font-weight:700' }, '›'),
    ]);
    const row = el('tr', { 'data-id': b.id, class: 'bot-row' }, [
      el('td', { class: 'num' }, String(i + 1)),
      nameCell,
      el('td', { class: 'num' }, b.symbol),
      kindCell,
      el('td', { class: 'num ' + moveClass(b.liveReturnPct) }, pctReturn(b.liveReturnPct)),
      el('td', { class: 'num ' + moveClass(b.r1w) }, pctReturn(b.r1w)),
      el('td', { class: 'num ' + moveClass(b.r1m) }, pctReturn(b.r1m)),
      el('td', { class: 'num ' + moveClass(b.r1y) }, pctReturn(b.r1y)),
      el('td', { class: 'num ' + moveClass(b.r5y) }, pctReturn(b.r5y)),
      el('td', { class: 'num ' + moveClass(b.r10y) }, pctReturn(b.r10y)),
      el('td', { class: 'num ' + moveClass(b.trackReturnPct) }, pctReturn(b.trackReturnPct)),
      el('td', { class: 'num' }, String(b.sharpe)),
      el('td', { class: 'num' }, b.maxDrawdownPct + '%'),
      el('td', { class: 'muted' }, b.position),
      // Colour equity by profit/loss vs the ₹1cr starting cash (green = in profit, red = down).
      // Compact crore form (the precise rupee value is the cell tooltip).
      el('td', { class: 'num ' + moveClass(b.equity - (data.startingCash || 10000000)), title: rupee(b.equity, 0) }, compactCr(b.equity)),
      removeCell,
    ]);
    row.title = "Open this bot's full portfolio, rationale & trade history";
    if (b.id === selectedId) row.style.boxShadow = 'inset 3px 0 0 var(--accent)';
    // CLICK A BOT -> go straight to its portfolio PAGE. We also mark it
    // selected + re-render so the equity-race chart highlights it (visible on "← Back").
    row.addEventListener('click', () => { selectedId = b.id; render(app, lastData); openBotPage(app, b.id); });
    tbody.append(row);
  });
  table.append(tbody);
  root.append(table);

  // Equity race: every bot, normalised; the last-opened (selected) one bright. Each line is
  // coloured by its KIND (matching the table badges) so 20+ curves read as a few strategy
  // CLUSTERS instead of a grey tangle — see how the baskets / pairs / F&O / equity groups
  // diverge over the ~20-year race.
  const sel = bots.find((b) => b.id === selectedId);
  const kc = kindColors();
  // Time-window selector above the race chart (1D/1W/.../MAX). The leaderboard ships only the
  // light ~120-point field curve per bot, so a window FINER than that resolution would collapse to a
  // misleading near-flat 2-point line — so we GREY OUT sub-resolution windows here (the per-bot PAGE,
  // which ships full-resolution tiers, is where short-window zoom is exact). minMs ≈ 3 of the ≤120
  // samples = the finest window the overview can honestly draw.
  const maxSpan = Math.max(0, ...bots.map((b) => spanOf(b.curve || [])));
  const raceMinMs = maxSpan > 0 ? maxSpan / 40 : 0;
  const effWin = effectiveWindow(raceWindow, maxSpan, raceMinMs);
  const winMs = windowMsOf(effWin);
  const winEl = $('#tourn-chart-windows');
  if (winEl) clear(winEl).append(windowButtons({ current: effWin, span: maxSpan, minMs: raceMinMs, onPick: (k) => { raceWindow = k; render(app, lastData); } }));
  const lines = bots.map((b) => {
    const w = windowed(b.curve || [], winMs); // slice each field curve to the chosen window
    return { values: w.map((p) => p.c), times: w.map((p) => p.t), color: kc[b.kind] || null, highlight: b.id === selectedId };
  });
  drawMultiLine($('#tourn-chart'), lines, { title: sel ? `${sel.name} (${sel.symbol}) — highlighted` : 'higher = better' });
  renderLegend($('#tourn-legend'), bots, kc);

  // Evolution history log.
  const hist = clear($('#tourn-history'));
  const events = (data.history || []).slice().reverse();
  if (evoOff) {
    hist.append(el('span', {}, 'Breeding is off — this board is the curated strategy line-up (no auto-generated bots). The genetic algorithm is kept in the code and can be switched back on.'));
  } else if (!events.length) {
    hist.append(el('span', {}, 'Evolution log: none yet — hit “Evolve ⚙” to breed a challenger.'));
  } else {
    hist.append(el('div', { style: 'font-weight:600;margin-bottom:2px' }, 'Evolution log'));
    events.slice(0, 8).forEach((e) => {
      // Grow mode (no retirement) logs an ADD; the legacy replace path logs both
      // the promoted winner and the bot it retired.
      hist.append(el('div', {}, e.retired
        ? `Gen ${e.gen}: promoted “${e.promoted}” → retired “${e.retired}”`
        : `Gen ${e.gen}: added “${e.promoted}”`));
    });
  }
}

// --- Per-bot detail PAGE ----------------------------------------------------
// A dedicated "page" (a routed sub-view off the Tournament tab — vanilla, no framework)
// that answers the headline questions: WHY the strategy trades the way it
// does, and (for a basket) WHY each stock was chosen at the latest rebalance — plus the
// portfolio, per-stock P&L, equity curve and the full trade history.

// Toggle between the leaderboard ("board") and the per-bot page.
function showBoard(visible) {
  const board = $('#tourn-board');
  const page = $('#tourn-botpage');
  if (board) board.hidden = !visible;
  if (page) page.hidden = visible;
}

// Fetch + render the full detail page for one bot (re-runs that bot server-side with
// trade + decision recording; memoised per state so a repeat open is free).
async function openBotPage(app, id) {
  if (!app || !app.api || typeof app.api.tournamentBot !== 'function') return;
  const body = $('#tourn-botpage-body');
  if (!body) return;
  const myReq = ++pageReqId; // claim this open; a newer open invalidates it
  showBoard(false);
  const row = ((lastData && lastData.bots) || []).find((b) => b.id === id) || null;
  clear(body).append(el('div', { class: 'muted' }, 'Loading full details…'));
  try {
    const d = await app.api.tournamentBot(id);
    if (myReq !== pageReqId) return; // a newer open superseded this fetch — don't clobber it
    renderBotPage(body, d, row);
  } catch {
    if (myReq !== pageReqId) return; // ...nor overwrite a newer page with a stale error
    clear(body).append(el('div', { class: 'muted' }, 'Couldn’t load this bot’s details — go back and try again.'));
  }
}

// A small label/value stat chip.
const stat = (label, value, cls) => el('div', { class: 'tourn-stat' }, [
  el('div', { class: 'muted', style: 'font-size:10px;text-transform:uppercase;letter-spacing:0.06em' }, label),
  el('div', { class: 'num ' + (cls || ''), style: 'font-size:15px;font-weight:650' }, value),
]);

function renderBotPage(body, d, row) {
  clear(body);
  if (!d || d.ok === false) { body.append(el('div', { class: 'muted' }, 'Bot detail unavailable.')); return; }
  const live = row ? row.liveReturnPct : null;
  const track = row ? row.trackReturnPct : (d.metrics ? d.metrics.totalReturnPct : null);
  const m = d.metrics || {};

  // Header.
  const intervalTag = d.interval && d.interval !== '1d' ? ` · ${d.interval} intraday` : '';
  body.append(el('h3', { style: 'margin:0 0 2px' }, `${d.name}`));
  body.append(el('div', { class: 'muted', style: 'margin-bottom:10px' },
    `${d.symbol} · ${d.kind}${intervalTag}${d.gen > 0 ? ` · evolved (gen ${d.gen})` : ''}${d.deployAt ? ` · deployed ${new Date(d.deployAt).toLocaleDateString('en-IN')}` : ''}`));

  // Stat row.
  const stats = el('div', { class: 'tourn-stats' });
  if (live != null) stats.append(stat('Live (today)', signed(live, 2) + '%', moveClass(live)));
  if (track != null) stats.append(stat('Track (life)', signed(track, 2) + '%', moveClass(track)));
  stats.append(stat('Sharpe', String(m.sharpe != null ? m.sharpe : '–')));
  stats.append(stat('MaxDD', (m.maxDrawdownPct != null ? m.maxDrawdownPct : '–') + '%'));
  stats.append(stat('Equity', rupee(d.equity, 0), moveClass((d.equity || 0) - 10000000)));
  stats.append(stat('Trades', String(d.tradeCount != null ? d.tradeCount : 0)));
  body.append(stats);

  // Strategy rationale (the "WHY the strategy" headline ask).
  const r = d.rationale;
  if (r) {
    const card = el('div', { class: 'card', style: 'margin-top:12px' });
    card.append(el('div', { style: 'font-weight:650;margin-bottom:4px' }, '🧠 Strategy — ' + r.headline));
    card.append(el('div', { class: 'muted', style: 'margin-bottom:8px;line-height:1.5' }, r.thesis));
    if (Array.isArray(r.params) && r.params.length) {
      const dl = el('div', { class: 'tourn-params' });
      r.params.forEach((p) => dl.append(el('div', { class: 'tourn-param' }, [
        el('span', { class: 'muted', style: 'min-width:120px;display:inline-block' }, p.label),
        el('span', {}, p.value),
      ])));
      card.append(dl);
    }
    if (r.risk) card.append(el('div', { class: 'muted', style: 'margin-top:8px;font-style:italic;line-height:1.5' }, '⚠ ' + r.risk));
    body.append(card);
  }

  // Holdings & WHY each stock was chosen (the headline ask). A BASKET decision carries
  // `candidates` (rank table); a PAIRS decision carries `pairs` (spread table) — dispatch
  // on shape so each kind gets its own "why" view.
  if (d.decision && Array.isArray(d.decision.pairs)) renderPairsDecision(body, d.decision);
  else if (d.decision) renderDecision(body, d.decision);
  else if (d.holdings && d.holdings.length) {
    body.append(el('div', { class: 'card', style: 'margin-top:12px' }, `Currently holding: ${d.holdings.map((h) => `${h.symbol} ${Math.round(h.weightPct)}%`).join(' · ')}`));
  } else {
    body.append(el('div', { class: 'card muted', style: 'margin-top:12px' }, `Single-symbol strategy on ${d.symbol}. Current position: ${d.position}.`));
  }

  // Per-stock P&L contribution (who made / lost money).
  if (Array.isArray(d.contributions) && d.contributions.length > 1) renderContributions(body, d.contributions);

  // Equity curve with time-window zoom (1D/1W/.../MAX). Prefer the detail's FULL multi-
  // resolution curve (so a short window is EXACT — the 1M tier keeps full daily resolution),
  // falling back to the leaderboard row's light 120-point curve for older payloads / test stubs.
  const curveSrc = (Array.isArray(d.curveTiers) && d.curveTiers.length) ? d.curveTiers
    : (row && Array.isArray(row.curve) && row.curve.length > 1 ? row.curve : null);
  if (curveSrc) {
    body.append(el('div', { class: 'muted', style: 'margin:14px 0 2px' }, 'Equity curve'));
    const span = spanOf(curveSrc);
    const winRow = el('div');
    const cv = el('canvas', { class: 'canvas', height: '200' });
    body.append(winRow);
    body.append(cv);
    // Switch the visible window purely client-side (no re-fetch — the bot page is static): the
    // full curve is already in hand, so a click just re-slices + redraws.
    const redraw = () => {
      const eff = effectiveWindow(botpageWindow, span);
      clear(winRow).append(windowButtons({ current: eff, span, onPick: (k) => { botpageWindow = k; redraw(); } }));
      const w = windowed(curveSrc, windowMsOf(eff));
      // Pick the axis granularity from the VISIBLE window's span, NOT the bot's raw bar size.
      // An intraday (60m) bot's MAX window spans ~years, so clock-time (HH:MM) labels would be
      // nonsensical strewn across that range — axisIntervalForSpan uses a daily (date) axis for any
      // window longer than ~2 days, and the bot's own interval only for genuinely short windows.
      // (Was the lone time-axis caller trusting the raw bot interval; the siblings positions.js /
      // autopilot.js already pick by span.)
      const wspan = w.length > 1 ? w[w.length - 1].t - w[0].t : 0;
      drawLineChart(cv, w, { interval: axisIntervalForSpan(wspan, d.interval || '1d'), timeAxis: true });
    };
    redraw();
    // Make the realised-vs-unrealised distinction explicit. The curve is MARKED TO
    // MARKET — it includes the unrealised P&L of any OPEN positions (e.g. an
    // option-selling bot's live strangle), so it can dip or rise on days with no
    // trade, and an open loss that later recovers never shows up as a booked trade.
    // The trade table below only books P&L when a position is CLOSED (realised).
    body.append(el('div', { class: 'muted', style: 'font-size:0.85em;margin-top:4px;line-height:1.45' },
      'Marked to market — this line includes the unrealised profit/loss of any open positions, so it can move on days with no trade (and a dip that recovers before the position closes never becomes a booked trade). The table below books P&L only when a position is closed.'));
  }

  // Full trade history (reuse the leaderboard's trade renderer).
  const tradeBox = el('div', { style: 'margin-top:14px' });
  body.append(tradeBox);
  renderTrades(tradeBox, d);
}

// The rebalance-decision table: every name the basket scanned, its rank score + the
// indicators that drove it, and which made the cut (with their weight). The direct
// answer to "why was THIS stock chosen and that one not?".
function renderDecision(body, dec) {
  const card = el('div', { class: 'card', style: 'margin-top:12px' });
  card.append(el('div', { style: 'font-weight:650;margin-bottom:2px' }, '📌 Holdings & why — latest rebalance'));
  const when = Number.isFinite(dec.t) ? new Date(dec.t).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
  const cands = dec.candidates || [];
  const chosenCount = cands.filter((c) => c.chosen).length;
  // Quant surfaces (purely additive — only shown when the decision carries them):
  //   a FACTOR basket -> one z-score column per factor; an OPTIMISER basket -> a Risk %
  //   column (each chosen name's share of portfolio risk) + a weighting note.
  const factorNames = ((cands.find((c) => Array.isArray(c.factors)) || {}).factors || []).map((f) => f.name);
  const isOpt = dec.weighting === 'meanvar' || dec.weighting === 'riskparity';
  const engineNote = factorNames.length ? ` Ranked by a ${factorNames.length}-factor composite (${factorNames.join(', ')}).` : '';
  const weightNote = isOpt ? ` Sized by ${dec.weighting === 'meanvar' ? 'mean-variance (Markowitz)' : 'risk-parity'} on the names’ covariance.` : '';
  card.append(el('div', { class: 'muted', style: 'margin-bottom:8px;line-height:1.5' },
    dec.riskOn === false
      ? `As of ${when}: the market filter said RISK-OFF, so the basket sat entirely in cash this cycle.`
      : `As of ${when}: scanned ${dec.universeSize} names, ${dec.passedGate} passed the eligibility gate; the top ${chosenCount} (by score) were bought.${engineNote}${weightNote}`));

  if (cands.length) {
    const headerCells = [th('Rank'), th('Stock')];
    factorNames.forEach((fn) => headerCells.push(th(fn, `Cross-sectional z-score for the ${fn} factor (higher = better within the universe)`)));
    headerCells.push(th('Score', 'The composite ranking score (the factor blend / ML output, or the rule) — higher = more attractive'));
    headerCells.push(th('Rule score', 'The plain-rule rank score (the tie-break + cold/edge fallback)'));
    headerCells.push(th('Vol', '20-bar volatility'));
    if (isOpt) headerCells.push(th('Risk %', "This name's share of total portfolio risk (the optimiser's risk contribution)"));
    headerCells.push(th('Chosen', 'Whether it made the cut, and its target weight'));
    const table = el('table');
    table.append(el('thead', {}, el('tr', {}, headerCells)));
    const tbody = el('tbody');
    cands.forEach((c, i) => {
      const cells = [el('td', { class: 'num muted' }, String(i + 1)), el('td', {}, c.sym)];
      factorNames.forEach((fn) => {
        const f = (c.factors || []).find((x) => x.name === fn);
        cells.push(el('td', { class: 'num ' + (f ? moveClass(f.z) : 'muted') }, f ? signed(f.z, 2) : '–'));
      });
      cells.push(el('td', { class: 'num' }, c.score != null ? String(c.score) : '–'));
      cells.push(el('td', { class: 'num muted' }, c.ruleScore != null ? String(c.ruleScore) : '–'));
      cells.push(el('td', { class: 'num muted' }, c.vol != null ? (c.vol * 100).toFixed(1) + '%' : '–'));
      if (isOpt) cells.push(el('td', { class: 'num muted' }, c.riskPct != null ? c.riskPct + '%' : '–'));
      cells.push(el('td', { class: 'num ' + (c.chosen ? 'up' : 'muted') }, c.chosen ? `✓ ${c.weightPct}%` : '—'));
      const rowEl = el('tr', {}, cells);
      if (c.chosen) rowEl.style.boxShadow = 'inset 2px 0 0 var(--accent)';
      tbody.append(rowEl);
    });
    table.append(tbody);
    card.append(el('div', { class: 'table-wrap', style: 'max-height:320px;overflow:auto' }, table));
  }

  // What the ML model learned — feature WEIGHTS (ridge/logistic) or gain-based feature
  // IMPORTANCES (gbm/forest, flagged by mlWeights.importance), if it trained.
  if (dec.mlWeights && Array.isArray(dec.mlWeights.features)) {
    const what = dec.mlWeights.importance ? 'feature importance' : 'feature weights';
    card.append(el('div', { style: 'font-weight:600;margin:10px 0 2px' }, `What the ${dec.mlWeights.model} model learned (${what})`));
    const sorted = dec.mlWeights.features.slice().sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
    const wrap = el('div', { class: 'muted', style: 'line-height:1.6' });
    sorted.forEach((f) => wrap.append(el('div', {}, [
      el('span', { style: 'min-width:120px;display:inline-block' }, f.feature),
      el('span', { class: moveClass(f.weight) }, signed(f.weight, 4)),
    ])));
    card.append(wrap);
  }
  body.append(card);
}

// The PAIRS "why" view: the current state of every co-moving pair the bot is watching
// — its spread z-score (how stretched it is), the hedge ratio β, the trailing
// correlation, the AR(1) mean-reversion coefficient, and whether it is currently long /
// short the spread or flat. The direct answer to "what is this market-neutral bot doing?".
function renderPairsDecision(body, dec) {
  const card = el('div', { class: 'card', style: 'margin-top:12px' });
  card.append(el('div', { style: 'font-weight:650;margin-bottom:2px' }, '🔗 Pairs & spreads — latest state'));
  const when = Number.isFinite(dec.t) ? new Date(dec.t).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
  const pairs = dec.pairs || [];
  const open = pairs.filter((p) => p.state !== 'flat').length;
  card.append(el('div', { class: 'muted', style: 'margin-bottom:8px;line-height:1.5' },
    `As of ${when}: watching up to ${dec.maxPairs} co-moving pair(s). A trade OPENS when a spread stretches past ±${dec.entryZ}σ (short the rich leg, buy the cheap one) and CLOSES near ±${dec.exitZ}σ. ${open} pair(s) currently open.`));
  if (pairs.length) {
    const table = el('table');
    table.append(el('thead', {}, el('tr', {}, [
      th('Pair', 'The two co-moving stocks'),
      th('Spread z', 'How far the spread is from its mean now (σ); past the entry threshold opens a trade'),
      th('Hedge β', 'OLS hedge ratio: spread = logA − β·logB'),
      th('Corr', 'Trailing return correlation of the two legs'),
      th('AR(1) φ', 'Mean-reversion speed: φ < 1 ⇒ the spread pulls back to its mean'),
      th('State', 'flat / long the spread (long A, short B) / short the spread (short A, long B)'),
    ])));
    const tbody = el('tbody');
    pairs.forEach((p) => {
      const row = el('tr', {}, [
        el('td', {}, `${p.a} / ${p.b}`),
        el('td', { class: 'num ' + (p.z != null ? moveClass(p.z) : 'muted') }, p.z != null ? signed(p.z, 2) : '–'),
        el('td', { class: 'num muted' }, p.beta != null ? String(p.beta) : '–'),
        el('td', { class: 'num muted' }, p.corr != null ? String(p.corr) : '–'),
        el('td', { class: 'num muted' }, p.phi != null ? String(p.phi) : '–'),
        el('td', { class: 'num ' + (p.state !== 'flat' ? 'up' : 'muted') }, p.state),
      ]);
      if (p.state !== 'flat') row.style.boxShadow = 'inset 2px 0 0 var(--accent)';
      tbody.append(row);
    });
    table.append(tbody);
    card.append(el('div', { class: 'table-wrap', style: 'max-height:320px;overflow:auto' }, table));
  }
  body.append(card);
}

function renderContributions(body, contribs) {
  const card = el('div', { class: 'card', style: 'margin-top:12px' });
  card.append(el('div', { style: 'font-weight:650;margin-bottom:6px' }, '💰 Per-stock booked P&L (who made / lost money)'));
  const table = el('table');
  table.append(el('thead', {}, el('tr', {}, [th('Stock'), th('Booked P&L', 'Realised profit/loss from closed trades in this name'), th('Now', 'Current weight if still held')])));
  const tbody = el('tbody');
  contribs.forEach((c) => tbody.append(el('tr', {}, [
    el('td', {}, c.symbol),
    el('td', { class: 'num ' + (c.realised ? moveClass(c.realised) : 'muted') }, c.realised ? signed(c.realised, 0) : '—'),
    el('td', { class: 'num muted' }, c.weightPct ? Math.round(c.weightPct) + '%' : '—'),
  ])));
  table.append(tbody);
  card.append(el('div', { class: 'table-wrap' }, table));
  body.append(card);
}

async function renderTournament(app) {
  let data;
  try {
    data = await app.api.tournament();
  } catch {
    // A failed refresh (e.g. the 503 the server returns during a Render redeploy,
    // which the 30s timer hits routinely): show the warming-up message AND clear
    // the sibling panes, so the tab never shows a STALE evolution log next to a
    // "warming up" table.
    clear($('#tourn-table')).append(el('div', { class: 'empty-state' }, 'Tournament is warming up — check back in a moment.'));
    clear($('#tourn-history'));
    // Clear the race-chart window buttons AND the colour legend too (same reason as the sibling
    // panes: never leave stale, still-clickable controls / a stale kind-legend next to the
    // "warming up" state).
    const winEl = $('#tourn-chart-windows');
    if (winEl) clear(winEl);
    const legEl = $('#tourn-legend');
    if (legEl) clear(legEl);
    drawMultiLine($('#tourn-chart'), [], { emptyMsg: 'warming up…' });
    return;
  }
  render(app, data);
}

// Wire a control button to an async API action with busy/toast handling.
function wireAction(btn, app, action, { confirm: confirmMsg } = {}) {
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (confirmMsg && typeof window.confirm === 'function' && !window.confirm(confirmMsg)) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const r = await action();
      if (r && r.ok === false) showToast(r.error || 'Action failed');
      else if (r && r.promoted) showToast(r.retired
        ? `Gen ${r.generation}: promoted “${r.promoted}” (retired “${r.retired}”)`
        : `Gen ${r.generation}: added “${r.promoted}”`);
      else if (r && r.full) showToast(`Board is full (${r.max} bots) — keeping all, not adding more.`);
      else if (r && r.promoted === null && r.generation != null) showToast(`Gen ${r.generation}: no challenger beat the field`);
      else if (r && r.added) showToast(`Added “${r.added}”`);
      // After an Evolve that added a bot, HIGHLIGHT that new bot (its id is r.promotedId)
      // so you can immediately compare it against the rest — that is the whole point of
      // grow mode. On "+ Add bot" (no id) fall back to the default top selection; on a
      // no-op keep the current selection.
      if (r && r.standings) { selectedId = r.promotedId ? r.promotedId : (r.added ? null : selectedId); render(app, r.standings); }
    } catch (e) {
      showToast('Failed: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });
}

function initTournament(app) {
  if (!wired) {
    wired = true;
    wireAction($('#btn-evolve'), app, () => app.api.evolveTournament());
    wireAction($('#btn-add-bot'), app, () => app.api.addTournamentBot());
    wireAction($('#btn-reset-tourn'), app, () => app.api.resetTournament(), { confirm: 'Reset the tournament to the original line-up at generation 0? Forward progress will be cleared.' });
    // The per-bot detail page's "back" button returns to the leaderboard.
    const back = $('#btn-botpage-back');
    if (back) back.addEventListener('click', () => showBoard(true));
    // Refresh while the tab is visible (cheap; the server caches standings). INSIDE
    // the `wired` guard so a second initTournament() can never stack a 2nd timer.
    setInterval(() => {
      if ($('#tab-tournament') && $('#tab-tournament').classList.contains('active')) renderTournament(app);
    }, 30000);
  }
}

export { initTournament, renderTournament, openBotPage };
