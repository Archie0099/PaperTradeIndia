// Two things the board was not saying out loud.
//
// (1) THE FAIR BAR IS A CONTROL, AND THE ADVISOR MUST NOT TURN IT INTO ADVICE.
//     `bar-universe-equal` holds the whole ~105-name universe at equal weight with no ranking
//     signal, no filter and no market timing. It is on the board as the yardstick every basket
//     must clear before "beats the index" means anything — its own note opens "Not a strategy".
//     It is deliberately STILL allowed to win the Auto-Pilot walk-forward, because a board that
//     cannot conclude "nothing here beats holding the whole universe blind" is flattering
//     itself. But that is a statement about the board, not a real-money instruction: mirroring
//     it by hand is ~105 delivery orders rebalanced monthly, each under 1% of the account.
//     Nothing previously stopped it — the advisor's four exclusions are F&O kind, PAIRS kind,
//     non-EQ legs and short quantities, and a long-only equity basket passes ALL FOUR.
//
// (2) A GATED BOT IS CHARGED THE HURDLE FOR STANDING ASIDE, AND THE BOARD HID IT.
//     Sharpe is excess of ~6.5%, charged on EVERY bar including bars spent flat in cash, on
//     which nothing credits interest. `summarize()` has computed `sharpeCashAdj`/`flatBarsPct`
//     since the fair bar was added, but the board’s own payload dropped both — so the leaderboard ranked
//     bots that sit in cash 22-34% of their life against an UNGATED fair bar (1.4%) with no
//     correction visible anywhere. Publishing them changes no ranked figure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTournament } from '../tournament/tournament.mjs';
import { buildAdvisorEntry } from '../tournament/advisor.mjs';

const DAY = 86_400_000;
const START = 1_500_000_000_000;

// A deterministic daily series — no RNG, no wall clock (a test must never read the clock
// for market-session logic, and a fixture that drifts is worse than no fixture).
function series(n = 400, start = START) {
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) { p *= 1 + (i % 7 === 0 ? 0.012 : -0.0018); out.push({ t: start + i * DAY, c: +p.toFixed(2) }); }
  return out;
}

// A champion whose book is PERFECTLY mirrorable: long-only, cash-market equity, finite prices.
// Every existing exclusion passes it. Only the `benchmark` flag can stop it.
const mkEntry = (detailOverrides = {}) => buildAdvisorEntry({
  autopilot: { currentBot: { id: 'x' } },
  getBotDetail: () => ({
    ok: true,
    id: 'x',
    name: 'X',
    kind: 'BASKET',
    mirror: {
      followable: true,
      equity: 1_000_000,
      positions: [
        { symbol: 'AAA', qty: 100, price: 500, kind: 'EQ' },
        { symbol: 'BBB', qty: 200, price: 250, kind: 'EQ' },
      ],
    },
    ...detailOverrides,
  }),
  seriesFor: (s) => (s === 'NIFTY' ? [{ t: START, c: 100 }] : []),
});

// --- (1) the advisor's fifth exclusion -----------------------------------------------------

test('the fair-bar CONTROL is excluded from real-money suggestions, with a stated reason', () => {
  const entry = mkEntry({ benchmark: true });
  assert.ok(entry, 'the day must still RECORD — a stand-aside is guidance too, and the trust clock counts it');
  assert.equal(entry.eligible, false, 'a control is not a strategy and must never become advice');
  assert.deepEqual(entry.targets, [], 'an ineligible day suggests nothing at all');
  assert.match(entry.reason, /fair-bar control/, 'the reason must name what was excluded, never scale it silently');
  assert.match(entry.reason, /yardstick/, 'and must say WHY, so the panel can explain itself');
});

test('the exclusion keys on the BENCHMARK FLAG, not on the shape of the book (control)', () => {
  // The identical book, minus the flag. If this came back ineligible the exclusion would be
  // firing on something incidental — the position count, the kind — rather than on identity.
  const entry = mkEntry({ benchmark: false });
  assert.equal(entry.eligible, true, 'an ordinary long-only equity basket is still perfectly mirrorable');
  assert.equal(entry.reason, null);
  assert.equal(entry.targets.length, 2, 'and still suggests its book');
});

test('a missing benchmark flag is treated as "not a control", never as undefined-ish truth', () => {
  // Nothing in the payload guarantees the key exists (an older persisted roster, a hand-built
  // detail in a test). Absent must mean "ordinary strategy", or a redeploy could silently mute
  // the advisor for every bot at once.
  const entry = mkEntry();
  assert.equal(entry.eligible, true);
  assert.equal(entry.targets.length, 2);
});

test('the control check runs BEFORE the instrument checks, so the reason names the real cause', () => {
  // Ordering lock. If a control ever held something unmirrorable too, the honest reason is
  // still "this is the yardstick" — that is a fact about the row, while a short leg is a fact
  // about today. Reporting the transient one would imply the bot becomes followable tomorrow.
  const entry = mkEntry({
    benchmark: true,
    kind: 'PAIRS',
    mirror: { followable: true, equity: 1_000_000, positions: [{ symbol: 'AAA', qty: -100, price: 500, kind: 'EQ' }] },
  });
  assert.equal(entry.eligible, false);
  assert.match(entry.reason, /fair-bar control/, 'identity beats instrument: the row IS a control regardless of today’s book');
});

// --- (2) the idle-cash gap, published ------------------------------------------------------

const CASH_SEED = [{
  id: 'gated',
  name: 'Gated single name',
  kind: 'EQ',
  symbol: 'NIFTY',
  // A marketGate that is shut for long stretches parks the bot in cash, which is exactly the
  // case the published figures exist to expose.
  spec: { kind: 'EQ', name: 'Gated', weight: 1, entry: ['>', ['price'], ['sma', 50]], exit: ['<', ['price'], ['sma', 50]] },
}];

test('a board row publishes sharpeCashAdj and flatBarsPct beside the ranked Sharpe', async () => {
  const t = await createTournament({ seed: CASH_SEED, backfillData: { NIFTY: series() }, persist: false, evolutionEnabled: false });
  await t.init();
  const row = t.getStandings().bots.find((b) => b.id === 'gated');
  assert.ok(row, 'the bot is on the board');
  assert.equal(typeof row.sharpe, 'number', 'the RANKED figure is unchanged and still present');
  assert.equal(typeof row.sharpeCashAdj, 'number', 'the cash-credited figure must reach the client — summarize has always computed it, the row used to drop it');
  assert.equal(typeof row.flatBarsPct, 'number', 'and the size of the assumption behind it');
  assert.ok(row.flatBarsPct >= 0 && row.flatBarsPct <= 100, `flatBarsPct is a percentage (got ${row.flatBarsPct})`);
  // Crediting interest on idle cash can only ever ADD return, so the adjusted figure can never
  // sit below the headline. (Equal is correct for a bot that is never flat.)
  assert.ok(row.sharpeCashAdj >= row.sharpe, `crediting idle cash cannot lower the score (${row.sharpeCashAdj} vs ${row.sharpe})`);
});

test('getBotDetail carries the same two figures, plus the benchmark flag', async () => {
  const t = await createTournament({ seed: CASH_SEED, backfillData: { NIFTY: series() }, persist: false, evolutionEnabled: false });
  await t.init();
  const d = t.getBotDetail('gated');
  assert.equal(d.ok, true);
  assert.equal(typeof d.metrics.sharpeCashAdj, 'number', 'the per-bot page is where there is room to show the gap');
  assert.equal(typeof d.metrics.flatBarsPct, 'number');
  assert.equal(d.benchmark, false, 'an ordinary bot is not a control — and the flag must be a real boolean, not undefined');
});

test('the benchmark flag survives the seed -> roster -> detail path', async () => {
  // The advisor reads this off getBotDetail, so a flag that is set in seed.mjs but lost in the
  // roster normaliser would re-open the hole silently and no other test would notice.
  const t = await createTournament({
    seed: [{ ...CASH_SEED[0], id: 'ctrl', benchmark: true }],
    backfillData: { NIFTY: series() },
    persist: false,
    evolutionEnabled: false,
  });
  await t.init();
  assert.equal(t.getBotDetail('ctrl').benchmark, true, 'the control flag must reach the advisor intact');
});
