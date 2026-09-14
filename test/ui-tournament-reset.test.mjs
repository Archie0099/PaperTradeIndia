// The RESET confirmation token, from the UI side.
//
// `/api/tournament/reset` restarts `deployedAt` and clears the live advisor log. The log itself
// is archived, but the 90-day "track record before trust" CLOCK restarts — and that clock cannot
// be recomputed from data, only waited out at one trading day per trading day, with missed days
// never back-filled. So the server refuses any reset that does not echo the board's CURRENT
// `deployedAt`, which a caller can only know by reading the board first. That stops blind POSTs,
// endpoint scanners and double-clicks, and makes a replayed request stale by construction.
//
// This file exists SEPARATELY from ui-tournament.test.mjs on purpose: `initTournament` guards
// itself with a module-level `wired` one-shot, so whichever test wires the buttons first owns
// them for the rest of the file. Node runs each test FILE in its own process, so a fresh file is
// the only way to get a fresh module and actually drive the reset button.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupDom } from '../test-helpers/dom-harness.mjs';
import { renderTournament, initTournament } from '../public/js/ui/tournament.js';
import api from '../public/js/api.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

function standings() {
  const curve = Array.from({ length: 20 }, (_, i) => ({ t: i * 864e5, c: 10000000 + i * 12000 }));
  return {
    deployedAt: Date.parse('2026-06-15T00:00:00Z'),
    generation: 0,
    liveBars: 0,
    startingCash: 10000000,
    asOf: 1000,
    history: [],
    bots: [
      { id: 'bh', name: 'Buy & Hold', symbol: 'NIFTY', kind: 'EQ', gen: 0, protected: true, note: '', explain: '', liveReturnPct: 0, trackReturnPct: 5.1, sharpe: 0.3, maxDrawdownPct: 12, position: 'long', equity: 10510000, curve },
      { id: 'bk', name: 'Momentum basket', symbol: '8 stocks', kind: 'BASKET', gen: 0, protected: false, note: '', explain: '', liveReturnPct: 0, trackReturnPct: 3.2, sharpe: 0.8, maxDrawdownPct: 7, position: 'long', equity: 10320000, curve },
    ],
  };
}

// ONE test, ONE click — deliberately. `initTournament` wires the buttons behind a module-level
// one-shot, so only the FIRST test in a file can actually drive them; a second test's
// `initTournament` is a no-op and its freshly-built DOM has no listener attached at all. Both
// facts about a reset (what it WARNS and what it SENDS) therefore have to be asserted from the
// same click, which is also the more honest test: they are two halves of one interaction.
test('the reset button warns about the clock and sends the current deployedAt', async () => {
  const dom = setupDom();
  const data = standings();
  let sentConfirm = 'NOT CALLED';
  let msg = '';
  const app = dom.makeApp({
    api: Object.assign(dom.makeApiStub(), {
      tournament: async () => data,
      resetTournament: async (confirm) => { sentConfirm = confirm; return { ok: true }; },
    }),
  });
  window.confirm = (m) => { msg = m; return true; };
  await renderTournament(app);
  dom.withoutTimers(() => initTournament(app));
  dom.fire(dom.$('#btn-reset-tourn'), 'click');
  await flush();

  // WHAT IT SENDS. The server refuses any reset that does not echo the board's current
  // deployedAt; if a refactor drops this argument, reset breaks against a guard that still
  // looks correct from the server side.
  assert.equal(sentConfirm, data.deployedAt, 'the reset must echo the deployedAt the user is looking at');

  // WHAT IT WARNS. The old wording was "forward progress will be cleared", which reads as
  // recoverable. The log IS archived — but the clock restarts and can only be waited out, so
  // the dialog has to say both or the confirmation is not informed consent.
  assert.match(msg, /track-record clock/, 'the dialog must name the clock');
  assert.match(msg, /archived/, 'and say the log itself survives, so the warning is accurate rather than alarming');
  assert.match(msg, /never back-filled/, 'and say why waiting is the only way back');
});

test('the api layer puts the confirmation in the URL the server actually reads', async () => {
  // Locks the wire contract independently of the button: the server reads `req.query.confirm`,
  // so a change to this URL shape would break reset while every UI-side test still passed.
  let seen = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { seen = url; return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  try {
    await api.resetTournament(1750000000000);
    assert.match(seen, /^\/api\/tournament\/reset\?confirm=1750000000000$/, `unexpected reset URL: ${seen}`);
    // A missing value must still produce a well-formed request that the server can REFUSE,
    // rather than the string "undefined" or a thrown TypeError on the client.
    await api.resetTournament(undefined);
    assert.match(seen, /^\/api\/tournament\/reset\?confirm=$/, `a missing confirm must send an empty one, got: ${seen}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});
