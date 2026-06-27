// ---------------------------------------------------------------------------
// ui/orders.js
// The Orders tab: the order ticket (place MARKET/LIMIT, BUY/SELL for equity,
// futures and options) and the order-history table (filled / pending /
// cancelled / rejected, each with a reason). F&O quantity is entered in LOTS;
// we show the lot size and convert to units inside the engine.
// ---------------------------------------------------------------------------

import { $, el, clear, rupee, signed, moveClass } from './dom.js';

// Read the current ticket form into a plain object.
function readTicket() {
  const kind = $('#t-kind').value;
  const symbol = $('#t-symbol').value.trim().toUpperCase();
  // Equities trade in single shares — there is no lot size. The lot-size field
  // is for F&O only and is HIDDEN when kind === 'EQ', but a value left over from
  // a previous Future/Option selection would otherwise silently multiply the
  // equity order size (e.g. "buy 10 shares" → 10 × 75 = 750). Force 1 for EQ.
  const lotSize = kind === 'EQ' ? 1 : Math.max(1, Number($('#t-lotsize').value) || 1);
  const inst = { kind, symbol, lotSize };
  if (kind !== 'EQ') inst.expiry = $('#t-expiry').value.trim();
  if (kind === 'OPT') {
    inst.strike = Number($('#t-strike').value);
    inst.optType = $('#t-opttype').value;
  }
  const slRaw = $('#t-sl').value;
  const tgtRaw = $('#t-target').value;
  return {
    instrument: inst,
    side: $('#t-side').value,
    orderType: $('#t-ordertype').value,
    lots: Math.max(1, Number($('#t-lots').value) || 1),
    price: Number($('#t-price').value),
    limitPrice: Number($('#t-price').value),
    // Optional bracket exits (blank = none) attached to the resulting position.
    stopLoss: slRaw.trim() !== '' && Number(slRaw) > 0 ? Number(slRaw) : undefined,
    target: tgtRaw.trim() !== '' && Number(tgtRaw) > 0 ? Number(tgtRaw) : undefined,
  };
}

// Show/hide F&O-only and option-only rows; relabel quantity field.
function syncTicketVisibility() {
  const kind = $('#t-kind').value;
  document.querySelectorAll('.fno-only').forEach((n) => n.classList.toggle('hidden', kind === 'EQ'));
  document.querySelectorAll('.opt-only').forEach((n) => n.classList.toggle('hidden', kind !== 'OPT'));
  $('#lots-label').firstChild.textContent = kind === 'EQ' ? 'Quantity (shares)' : 'Quantity (lots)';
}

// Live margin / cost estimate shown under the form.
function renderEstimate(app) {
  const box = $('#ticket-estimate');
  const t = readTicket();
  const price = t.price || t.limitPrice;
  if (!Number.isFinite(price) || price <= 0) {
    box.textContent = 'Enter a price (or click "Get last price") to see the margin estimate.';
    return;
  }
  const qty = t.lots * t.instrument.lotSize;
  const { margin, breakdown } = app.engine.estimateMargin(t.instrument, t.side, qty, price);
  const available = app.engine.availableFunds();
  const ok = margin <= available + 1e-6;
  box.innerHTML = '';
  box.append(
    el('div', {}, `Quantity: ${qty} unit(s)  •  Estimated requirement: ${rupee(margin, 0)}`),
    el('div', { class: 'muted' }, breakdown + '  (ESTIMATE, not broker-accurate)'),
    el('div', { class: ok ? 'up' : 'down' }, `Available funds: ${rupee(available, 0)} — ${ok ? 'OK' : 'INSUFFICIENT'}`)
  );
}

function initOrders(app) {
  // React to changes that affect visibility / estimate.
  ['t-kind', 't-side', 't-ordertype', 't-lots', 't-price', 't-lotsize', 't-strike', 't-symbol'].forEach(
    (id) => {
      const node = document.getElementById(id);
      node.addEventListener('input', () => {
        syncTicketVisibility();
        renderEstimate(app);
      });
      node.addEventListener('change', () => {
        syncTicketVisibility();
        renderEstimate(app);
      });
    }
  );
  syncTicketVisibility();

  // "Get last price": fetch the equity/index quote and drop it into the price.
  $('#t-refresh-price').addEventListener('click', async () => {
    // This fetches the UNDERLYING spot from Yahoo, which is NOT the premium of
    // an option or future. Dropping the index level (e.g. 23,500) into an
    // option's price field would seed a wildly wrong premium, so refuse for F&O
    // — their prices come from the Option Chain (click an LTP there).
    if ($('#t-kind').value !== 'EQ') {
      $('#ticket-estimate').textContent =
        'For options/futures, load the price by clicking an LTP in the Option Chain. "Get last price" only works for equities/indices.';
      return;
    }
    const sym = $('#t-symbol').value.trim().toUpperCase();
    if (!sym) return;
    try {
      const q = await app.api.quote(sym);
      $('#t-price').value = q.ltp;
      renderEstimate(app);
    } catch (err) {
      $('#ticket-estimate').textContent = 'Could not fetch price: ' + err.message;
    }
  });

  // Submit -> place a simulated order.
  $('#order-ticket').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = readTicket();
    // An Option needs a real strike. An empty strike field parses to 0
    // (Number('') === 0), which would otherwise place a nonsensical
    // "SYMBOL 0 CE" contract. Reject before it reaches the engine.
    if (t.instrument.kind === 'OPT' && !(t.instrument.strike > 0)) {
      const box = $('#ticket-estimate');
      box.innerHTML = '';
      box.append(el('div', { class: 'down' }, '✗ Enter a valid strike price for the option.'));
      return;
    }
    // For a MARKET order with no price typed, use the last known price.
    if (t.orderType === 'MARKET' && (!t.price || t.price <= 0)) {
      const key = keyForInstrument(t.instrument);
      const last = app.engine.state.lastPrices[key];
      if (last) t.price = last;
    }
    const order = app.engine.placeOrder(t);
    app.tabs.show('orders');
    // Brief inline feedback in the estimate box.
    const box = $('#ticket-estimate');
    if (order.status === 'REJECTED') {
      box.innerHTML = '';
      box.append(el('div', { class: 'down' }, '✗ Rejected: ' + order.reason));
    } else if (order.status === 'FILLED') {
      box.innerHTML = '';
      box.append(el('div', { class: 'up' }, `✓ Filled ${order.qty} @ ${order.fillPrice}`));
    } else {
      box.innerHTML = '';
      box.append(el('div', { class: 'muted' }, '⧖ Pending limit order — will fill when price crosses.'));
    }
  });

  renderEstimate(app);
}

// Mirror of engine.instrumentKey for the local "last price" lookup.
function keyForInstrument(inst) {
  if (inst.kind === 'EQ') return `EQ:${inst.symbol}`;
  if (inst.kind === 'FUT') return `FUT:${inst.symbol}:${inst.expiry}`;
  return `OPT:${inst.symbol}:${inst.expiry}:${inst.strike}:${inst.optType}`;
}

// Pre-fill the ticket from elsewhere (option chain / strategy "trade" click).
function loadTicket(app, inst, side, price, lots = 1) {
  $('#t-kind').value = inst.kind;
  $('#t-symbol').value = inst.symbol;
  $('#t-lotsize').value = inst.lotSize || 1;
  if (inst.expiry) $('#t-expiry').value = inst.expiry;
  if (inst.kind === 'OPT') {
    $('#t-strike').value = inst.strike;
    $('#t-opttype').value = inst.optType;
  }
  $('#t-side').value = side || 'BUY';
  $('#t-ordertype').value = 'MARKET';
  $('#t-lots').value = lots;
  if (price != null) $('#t-price').value = price;
  syncTicketVisibility();
  renderEstimate(app);
  app.tabs.show('orders');
}

function renderOrders(app) {
  const root = clear($('#orders-table'));
  const orders = app.engine.state.orders;
  const pending = orders.filter((o) => o.status === 'PENDING').length;
  $('#pending-count').textContent = pending ? `${pending} pending` : '';

  if (orders.length === 0) {
    root.append(el('div', { class: 'empty-state' }, 'No orders yet.'));
    return;
  }
  const table = el('table');
  table.append(
    el('thead', {}, el('tr', {}, ['Time', 'Instrument', 'Side', 'Type', 'Qty', 'Price', 'Realised', 'Status', ''].map((h) => el('th', {}, h))))
  );
  const tbody = el('tbody');
  for (const o of orders) {
    const time = new Date(o.ts).toLocaleTimeString('en-IN', { hour12: false });
    const price = o.status === 'FILLED' ? o.fillPrice : o.orderType === 'LIMIT' ? o.limitPrice : 'mkt';
    // Realised P&L locked in by this fill. Shown for any CLOSING fill (even a
    // break-even close where realised is exactly 0); opening/adding fills show '–'.
    const realised = o.status === 'FILLED' && o.closing ? o.realised : null;
    const row = el('tr', {}, [
      el('td', {}, time),
      el('td', {}, o.label),
      el('td', { class: o.side === 'BUY' ? 'up' : 'down' }, o.side),
      el('td', {}, o.orderType),
      el('td', { class: 'num' }, String(o.qty)),
      el('td', { class: 'num' }, typeof price === 'number' ? price.toFixed(2) : price),
      el('td', { class: 'num ' + (realised != null ? moveClass(realised) : '') }, realised != null ? signed(realised, 0) : '–'),
      el('td', {}, el('span', { class: 'pill ' + o.status }, o.status)),
      el('td', {}, o.status === 'PENDING' ? el('span', { class: 'row-actions' }, [modifyBtn(app, o), cancelBtn(app, o.id)]) : ''),
    ]);
    tbody.append(row);
    if (o.reason && (o.status === 'REJECTED' || o.status === 'CANCELLED')) {
      tbody.append(el('tr', {}, el('td', { colspan: '9', class: 'muted' }, '↳ ' + o.reason)));
    }
  }
  table.append(tbody);
  root.append(table);
}

function cancelBtn(app, id) {
  const b = el('button', { class: 'btn btn-mini' }, 'Cancel');
  b.addEventListener('click', () => app.engine.cancelOrder(id));
  return b;
}

// Modify a resting limit order's price (prompt-based; vanilla, no modal lib).
function modifyBtn(app, o) {
  const b = el('button', { class: 'btn btn-mini' }, 'Modify');
  b.title = 'Change the limit price';
  b.addEventListener('click', () => {
    const input = prompt(`New limit price for ${o.label} (current ${o.limitPrice}):`, String(o.limitPrice));
    if (input === null) return;
    const price = Number(input);
    if (!Number.isFinite(price) || price <= 0) return;
    const res = app.engine.modifyOrder(o.id, { limitPrice: price });
    // modifyOrder leaves the price unchanged if it can't be funded — flag it inline.
    if (res && res.limitPrice !== price) {
      alert('Could not modify: the new price needs more funds than are available.');
    }
  });
  return b;
}

export { initOrders, renderOrders, loadTicket, renderEstimate };
