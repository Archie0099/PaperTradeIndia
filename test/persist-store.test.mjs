// Remote persistence for the tournament's live-forward state (tournament/persistStore.mjs)
// + the tournament round-trip it enables: a redeploy on a fresh disk restores the forward
// record (live closes + deploy date) from the store, so liveBars no longer resets to 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPersistStore } from '../tournament/persistStore.mjs';
import { createTournament } from '../tournament/tournament.mjs';

const DAY = 86_400_000;
// A small deterministic daily series (no RNG / no clock — reproducible).
function series(n = 400, start = 1_500_000_000_000) {
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) { p *= 1 + (i % 7 === 0 ? 0.012 : -0.0018); out.push({ t: start + i * DAY, c: +p.toFixed(2) }); }
  return out;
}

// --- the store adapter itself (stubbed fetch, no network) -------------------
test('persistStore is a strict NO-OP when unconfigured (byte-identical fallback)', async () => {
  const s = createPersistStore({ token: '', gistId: '' });
  assert.equal(s.enabled, false);
  assert.equal(await s.load(), null);
  assert.doesNotThrow(() => s.save({ a: 1 })); // silent, no throw
});

test('persistStore.load parses the gist file content; save PATCHes a coalesced snapshot', async () => {
  const calls = [];
  let stored = JSON.stringify({ deployedAt: 5, live: { NIFTY: [{ t: 1, c: 2 }] } });
  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push(method);
    if (method === 'GET') return { ok: true, json: async () => ({ files: { 'tournament-state.json': { content: stored } } }) };
    stored = JSON.parse(opts.body).files['tournament-state.json'].content; // PATCH
    return { ok: true, json: async () => ({}) };
  };
  const s = createPersistStore({ token: 't', gistId: 'g', fetchImpl });
  assert.equal(s.enabled, true);

  const loaded = await s.load();
  assert.equal(loaded.deployedAt, 5);
  assert.deepEqual(loaded.live.NIFTY, [{ t: 1, c: 2 }]);

  s.save({ deployedAt: 9, live: {} });
  await s.flush();
  assert.equal(JSON.parse(stored).deployedAt, 9, 'the newest snapshot is persisted');
  assert.ok(calls.includes('PATCH'));
});

test('persistStore.save snapshots so a later in-place mutation is not persisted', async () => {
  let stored = null;
  const fetchImpl = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'PATCH') stored = JSON.parse(opts.body).files['tournament-state.json'].content;
    return { ok: true, json: async () => ({}) };
  };
  const s = createPersistStore({ token: 't', gistId: 'g', fetchImpl });
  const live = { NIFTY: [{ t: 1, c: 2 }] };
  const blob = { deployedAt: 1, live };
  s.save(blob);
  live.NIFTY.push({ t: 2, c: 3 }); // mutate AFTER save — must not leak into the persisted copy
  await s.flush();
  assert.equal(JSON.parse(stored).live.NIFTY.length, 1, 'the persisted snapshot is frozen at save() time');
});

test('persistStore.load returns null on a non-ok response or bad JSON (best-effort)', async () => {
  const s1 = createPersistStore({ token: 't', gistId: 'g', fetchImpl: async () => ({ ok: false }) });
  assert.equal(await s1.load(), null);
  const s2 = createPersistStore({ token: 't', gistId: 'g', fetchImpl: async () => ({ ok: true, json: async () => ({ files: { 'tournament-state.json': { content: '{not json' } } }) }) });
  assert.equal(await s2.load(), null);
});

// --- the tournament round-trip: a "redeploy" restores the forward record ----
function memStore() {
  let blob = null;
  return { enabled: true, load: async () => blob, save: (b) => { blob = JSON.parse(JSON.stringify(b)); }, flush: async () => {}, _blob: () => blob };
}
const SEED = [{ id: 'buy-hold', name: 'Buy & Hold', kind: 'EQ', symbol: 'NIFTY', protected: true, spec: { kind: 'EQ', name: 'Buy & Hold', weight: 1 } }];

test('a redeploy (fresh disk) restores live closes + the ORIGINAL deploy date from the remote store', async () => {
  const store = memStore();
  const data = { NIFTY: series() };

  // First deploy: boots, stamps a deploy date, appends a forward/live bar, mirrors to the store.
  const a = await createTournament({ seed: SEED, backfillData: data, persist: false, persistStore: store, evolutionEnabled: false });
  await a.init();
  const deployA = a.getStandings().deployedAt;
  assert.ok(deployA, 'the first deploy stamps a deploy date');
  const lastT = data.NIFTY[data.NIFTY.length - 1].t;
  a._appendLiveClose('NIFTY', { t: lastT + DAY, c: 321.0 }); // a genuine forward bar
  assert.equal(a.getStandings().liveBars, 1, 'the forward bar is counted live');
  assert.ok(store._blob() && store._blob().live.NIFTY, 'the store captured the forward bar');

  // "Redeploy": a brand-new tournament with NO local disk but the SAME remote store.
  const b = await createTournament({ seed: SEED, backfillData: data, persist: false, persistStore: store, evolutionEnabled: false });
  await b.init();
  assert.equal(b.getStandings().deployedAt, deployA, 'the deploy date is restored (forward clock stays continuous)');
  assert.equal(b.getStandings().liveBars, 1, 'the forward bar survives the redeploy');
  assert.equal(b._state().live.NIFTY[0].c, 321.0, 'the exact restored live close');
});

test('with NO store, a redeploy resets the forward clock (documents the gap the store closes)', async () => {
  const data = { NIFTY: series() };
  const a = await createTournament({ seed: SEED, backfillData: data, persist: false, evolutionEnabled: false });
  await a.init();
  a._appendLiveClose('NIFTY', { t: data.NIFTY[data.NIFTY.length - 1].t + DAY, c: 321.0 });
  assert.equal(a.getStandings().liveBars, 1);
  // A fresh instance with no persistence starts over — liveBars 0 (the ephemeral-disk behaviour).
  const b = await createTournament({ seed: SEED, backfillData: data, persist: false, evolutionEnabled: false });
  await b.init();
  assert.equal(b.getStandings().liveBars, 0, 'without a store the forward record is lost on redeploy');
});
