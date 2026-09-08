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

test('a failed READ names the status AND its meaning on the log — and never the token', async () => {
  // An unreadable store is silent by design (fail-closed, best-effort) and that silence once
  // hid an expired token for three WEEKS: the forward record stopped accumulating and nothing
  // anywhere said why. The HTTP status IS the diagnosis, so the log has to carry it.
  const TOKEN = 'ghp_SUPER_SECRET_never_log_me';
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    for (const status of [401, 403, 404, 500]) {
      const s = createPersistStore({ token: TOKEN, gistId: 'g', fetchImpl: async () => ({ ok: false, status }) });
      assert.equal(await s.load(), null, `HTTP ${status} reads as unreadable`);
    }
    // A HEALTHY read must stay silent — a warning that cries wolf gets ignored.
    const ok = createPersistStore({ token: TOKEN, gistId: 'g', fetchImpl: async () => ({ ok: true, json: async () => ({ files: { 'tournament-state.json': { content: '{"deployedAt":1}' } } }) }) });
    assert.equal((await ok.load()).deployedAt, 1);
  } finally {
    console.warn = realWarn;
  }
  assert.equal(warns.length, 4, 'one warning per failed read, none for the healthy one');
  assert.match(warns[0], /401/);
  assert.match(warns[0], /expired or revoked/i, '401 is explained, not just numbered');
  assert.match(warns[1], /403/);
  assert.match(warns[1], /scope|rate/i);
  assert.match(warns[2], /404/);
  assert.match(warns[2], /gist id/i);
  assert.ok(warns.every((w) => w.includes('not') && /reset|restor/i.test(w)), 'each says what the consequence is');
  assert.ok(warns.every((w) => !w.includes(TOKEN)), 'the credential is NEVER written to the log');
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

test('a redeploy does NOT restore the ROSTER — a seed edit (cull) takes effect, forward record still carries over', async () => {
  const store = memStore();
  const data = { NIFTY: series() };
  const OLD = [...SEED, { id: 'cull-me', name: 'Cull me', kind: 'EQ', symbol: 'NIFTY', spec: { kind: 'EQ', name: 'Cull me', weight: 1 } }];

  // First deploy runs the OLD 2-bot line-up and mirrors its state (incl. roster) to the store.
  const a = await createTournament({ seed: OLD, backfillData: data, persist: false, persistStore: store, evolutionEnabled: false });
  await a.init();
  a._appendLiveClose('NIFTY', { t: data.NIFTY[data.NIFTY.length - 1].t + DAY, c: 300 });
  assert.deepEqual(a.getStandings().bots.map((x) => x.id).sort(), ['buy-hold', 'cull-me']);

  // Redeploy after editing seed.mjs to CULL 'cull-me'. The board must run the NEW seed, not the
  // roster the store still carries — otherwise every curated board edit would silently revert.
  const b = await createTournament({ seed: SEED, backfillData: data, persist: false, persistStore: store, evolutionEnabled: false });
  await b.init();
  assert.deepEqual(b.getStandings().bots.map((x) => x.id), ['buy-hold'], 'the culled bot must NOT resurrect from the store');
  assert.equal(b.getStandings().liveBars, 1, 'but the forward record (live closes) still carries over');
});

test('a corrupt restored live map is sanitised — bad bars and non-array keys are dropped', async () => {
  const store = {
    enabled: true,
    load: async () => ({ deployedAt: 5, live: { NIFTY: [{ t: 1e12, c: 100 }, { t: 'x', c: 2 }, { t: 2e12, c: NaN }], JUNK: 'notarray' }, generation: 0, history: [] }),
    save: () => {}, flush: async () => {},
  };
  const t = await createTournament({ seed: SEED, backfillData: { NIFTY: series() }, persist: false, persistStore: store, evolutionEnabled: false });
  await t.init();
  const live = t._state().live.NIFTY;
  assert.ok(Array.isArray(live) && live.length === 1 && live[0].c === 100, 'only the finite {t,c} bar survives');
  assert.equal(t._state().live.JUNK, undefined, 'a non-array key is dropped');
});

test('load() follows raw_url when the gist file is >1MB truncated', async () => {
  const full = JSON.stringify({ deployedAt: 7, live: { NIFTY: [{ t: 1, c: 2 }] } });
  let rawFetched = false;
  const fetchImpl = async (url) => {
    if (String(url).includes('/gists/')) return { ok: true, json: async () => ({ files: { 'tournament-state.json': { content: full.slice(0, 4), truncated: true, raw_url: 'https://raw.example/xyz' } } }) };
    rawFetched = true; // raw_url branch
    return { ok: true, text: async () => full };
  };
  const s = createPersistStore({ token: 't', gistId: 'g', fetchImpl });
  const blob = await s.load();
  assert.equal(rawFetched, true, 'the full content was fetched via raw_url');
  assert.equal(blob.deployedAt, 7, 'the un-truncated blob parses correctly');
});

// --- FAIL CLOSED: an UNREADABLE store must never be overwritten --------------
test('persistStore refuses to WRITE after a failed read, but a genuinely EMPTY gist stays writable', async () => {
  // The data-loss bug: load() returned null for BOTH "the gist is empty" and "the read
  // failed", so one transient 503/timeout/truncated read made the tournament stamp a fresh
  // forward clock and PATCH that empty state over the only durable copy — destroying the
  // live closes, the deploy date and the append-only advisor log, self-perpetuatingly.
  const patched = [];
  const failing = (kind) => async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'PATCH') { patched.push(JSON.parse(opts.body)); return { ok: true, text: async () => '' }; }
    if (kind === 'notok') return { ok: false };
    if (kind === 'throw') throw new Error('socket hang up');
    if (kind === 'truncated') return { ok: true, json: async () => ({ files: { 'tournament-state.json': { content: '{"deployedAt":5,"li', truncated: true, raw_url: 'https://raw/x' } } }) };
    return { ok: true, json: async () => ({ files: { 'tournament-state.json': { content: '{bad json' } } }) };
  };
  for (const kind of ['notok', 'throw', 'truncated', 'badjson']) {
    patched.length = 0;
    const fetchImpl = kind === 'truncated'
      ? async (url, opts = {}) => (String(url).startsWith('https://raw/') ? { ok: false } : failing('truncated')(url, opts))
      : failing(kind);
    const s = createPersistStore({ token: 't', gistId: 'g', fetchImpl });
    assert.equal(await s.load(), null, `${kind}: nothing is returned`);
    assert.equal(s.readFailed(), true, `${kind}: the read is known to have FAILED`);
    s.save({ deployedAt: 1, live: {}, advisorLog: [] });
    await s.flush();
    assert.equal(patched.length, 0, `${kind}: an unreadable store is never overwritten`);
  }

  // A gist that exists but holds no file yet = the first-ever boot. That is an honest
  // empty read, and it MUST stay writable or persistence could never bootstrap.
  patched.length = 0;
  const empty = createPersistStore({
    token: 't', gistId: 'g',
    fetchImpl: async (url, opts = {}) => {
      if ((opts.method || 'GET') === 'PATCH') { patched.push(JSON.parse(opts.body)); return { ok: true, text: async () => '' }; }
      return { ok: true, json: async () => ({ files: {} }) };
    },
  });
  assert.equal(await empty.load(), null);
  assert.equal(empty.readFailed(), false, 'an empty gist read FINE — it is simply empty');
  empty.save({ deployedAt: 1, live: {} });
  await empty.flush();
  assert.equal(patched.length, 1, 'the first-ever boot can still bootstrap the store');
});

test('a transient store read failure does NOT wipe the forward record (the whole-tournament path)', async () => {
  // End-to-end through the REAL store adapter against a fake gist backend.
  // Deploy 1 writes a real forward record. Deploy 2 boots on a fresh disk but its READ of
  // the gist fails; it must not push its fresh empty state over that record — so deploy 3,
  // whose read works, still finds the ORIGINAL deploy date and the live bar.
  let gistContent = null; // what the fake gist holds
  let failRead = false;
  const makeStore = () => createPersistStore({
    token: 't', gistId: 'g',
    fetchImpl: async (url, opts = {}) => {
      if ((opts.method || 'GET') === 'PATCH') {
        gistContent = JSON.parse(opts.body).files['tournament-state.json'].content;
        return { ok: true, text: async () => '' };
      }
      if (failRead) return { ok: false }; // the transient failure (503 / rate limit / abort)
      return { ok: true, json: async () => ({ files: gistContent == null ? {} : { 'tournament-state.json': { content: gistContent } } }) };
    },
  });
  const data = { NIFTY: series() };

  const a = await createTournament({ seed: SEED, backfillData: data, persist: false, persistStore: makeStore(), evolutionEnabled: false });
  await a.init();
  const deployA = a.getStandings().deployedAt;
  a._appendLiveClose('NIFTY', { t: data.NIFTY[data.NIFTY.length - 1].t + DAY, c: 321 });
  await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget PATCH land
  const saved = gistContent;
  assert.ok(saved && JSON.parse(saved).live.NIFTY.length === 1, 'deploy 1 stored a forward bar');

  failRead = true;
  const b = await createTournament({ seed: SEED, backfillData: data, persist: false, persistStore: makeStore(), evolutionEnabled: false });
  await b.init();
  b._appendLiveClose('NIFTY', { t: data.NIFTY[data.NIFTY.length - 1].t + 2 * DAY, c: 322 });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(gistContent, saved, 'a boot that could not READ the store must not WRITE to it');

  failRead = false;
  const c = await createTournament({ seed: SEED, backfillData: data, persist: false, persistStore: makeStore(), evolutionEnabled: false });
  await c.init();
  assert.equal(c.getStandings().deployedAt, deployA, 'the original deploy clock survived the bad boot');
  assert.equal(c.getStandings().liveBars, 1, 'so did the forward bar');
});

test('the board REPORTS what the remote store did, so a non-restore is diagnosable from outside', async () => {
  // A reset forward clock looks identical from the deployed site whether the read FAILED (the
  // fail-closed guard refused to overwrite — nothing lost, it returns next boot), the store is
  // unconfigured, or the store genuinely is empty and this process just stamped a fresh clock
  // over it. Those need opposite responses, and there was no way to tell them apart. Now the
  // payload says which happened.
  const data = { NIFTY: series() };

  // (a) unconfigured: enabled false, nothing attempted.
  const off = await createTournament({ seed: SEED, backfillData: data, persist: false, evolutionEnabled: false });
  await off.init();
  assert.deepEqual(off.getStandings().persist, { enabled: false, attempted: false, restored: false, readFailed: false });

  // (b) configured and the read FAILS -> attempted, not restored, readFailed true.
  const failing = createPersistStore({ token: 't', gistId: 'g', fetchImpl: async () => ({ ok: false }) });
  const bad = await createTournament({ seed: SEED, backfillData: data, persist: false, persistStore: failing, evolutionEnabled: false });
  await bad.init();
  const pBad = bad.getStandings().persist;
  assert.equal(pBad.enabled, true);
  assert.equal(pBad.attempted, true, 'it did try to read');
  assert.equal(pBad.restored, false, 'and did not restore');
  assert.equal(pBad.readFailed, true, 'and says the READ is why — so the Gist is intact and untouched');

  // (c) configured, read fine, real record present -> restored true, readFailed false.
  let blob = null;
  const good = () => createPersistStore({
    token: 't', gistId: 'g',
    fetchImpl: async (url, opts = {}) => {
      if ((opts.method || 'GET') === 'PATCH') { blob = JSON.parse(opts.body).files['tournament-state.json'].content; return { ok: true, text: async () => '' }; }
      return { ok: true, json: async () => ({ files: blob == null ? {} : { 'tournament-state.json': { content: blob } } }) };
    },
  });
  const first = await createTournament({ seed: SEED, backfillData: data, persist: false, persistStore: good(), evolutionEnabled: false });
  await first.init();
  first._appendLiveClose('NIFTY', { t: data.NIFTY[data.NIFTY.length - 1].t + DAY, c: 321 });
  await new Promise((r) => setTimeout(r, 0));
  const second = await createTournament({ seed: SEED, backfillData: data, persist: false, persistStore: good(), evolutionEnabled: false });
  await second.init();
  const pGood = second.getStandings().persist;
  assert.equal(pGood.restored, true, 'a healthy read of a real record restores');
  assert.equal(pGood.readFailed, false);
});
