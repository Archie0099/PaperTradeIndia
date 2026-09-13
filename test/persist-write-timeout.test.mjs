// The remote store's WRITE timeout is separate from, and far longer than, its READ timeout.
//
// Why the asymmetry is deliberate: `timeoutMs` bounds the BOOT, because init() awaits load()
// and a hung read would hold the board down. A write has no such constraint — flush() is
// fire-and-forget, so a slow PATCH delays nothing. Charging the write the boot's ceiling is
// what made a slow-but-working PATCH look like a failure, and a dropped PATCH means the day's
// advisor entries live only in memory until the next restart discards them.
//
// Measured cause: writes were aborting with "timed out after 8000ms" on a ~44KB
// blob — not an auth error and not a size problem. Render documents that a free instance can
// be delayed "50 seconds or more".
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersistStore } from '../tournament/persistStore.mjs';

// Let the fire-and-forget flush settle. Polls for the outcome rather than sleeping a fixed
// span, so the test cannot pass or fail on timing luck: a fixed 30ms wait silently asserted
// "not finished yet" for a 60ms stubbed request.
const settled = async (check, budgetMs = 2000) => {
  const until = Date.now() + budgetMs;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
};

// A fetch stub that takes `delayMs` to answer, and honours an AbortSignal the way undici does.
function slowFetch(delayMs, record) {
  return (url, opts = {}) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        record.completed = (record.completed || 0) + 1;
        resolve({ ok: true, status: 200, text: async () => '{}' });
      }, delayMs);
      const sig = opts.signal;
      if (sig) {
        if (sig.aborted) { clearTimeout(timer); const e = new Error('aborted'); e.name = 'AbortError'; return reject(e); }
        sig.addEventListener('abort', () => {
          clearTimeout(timer);
          record.aborted = (record.aborted || 0) + 1;
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        }, { once: true });
      }
    });
}

test('a write slower than the READ timeout still succeeds — it gets its own, longer budget', async () => {
  const rec = {};
  const store = createPersistStore({
    token: 't', gistId: 'g', fetchImpl: slowFetch(60, rec),
    timeoutMs: 20,        // read ceiling: the write must NOT be charged this
    writeTimeoutMs: 5000, // write budget: generous, as in production
  });
  store.save({ hello: 'world' });
  await settled(() => rec.completed || rec.aborted);
  assert.equal(rec.completed, 1, 'the PATCH should have been allowed to finish');
  assert.ok(!rec.aborted, 'it must not be aborted by the read timeout');
  assert.equal(store.writeFailed(), false, 'a completed write is not a failure');
});

test('the write timeout still applies — a write beyond IT is aborted and reported', async () => {
  // Guards the other direction: the longer budget must be a budget, not "no timeout at all".
  const rec = {};
  const store = createPersistStore({
    token: 't', gistId: 'g', fetchImpl: slowFetch(200, rec),
    timeoutMs: 5000, writeTimeoutMs: 20,
  });
  store.save({ hello: 'world' });
  await settled(() => rec.completed || rec.aborted);
  assert.equal(rec.aborted, 1, 'a write past its own budget must abort');
  assert.equal(store.writeFailed(), true, 'and must be reported, never swallowed');
});

test('the READ path keeps the short boot-bounding ceiling', async () => {
  // load() is awaited by init(), so its timeout must stay tight regardless of the write budget.
  const rec = {};
  const store = createPersistStore({
    token: 't', gistId: 'g', fetchImpl: slowFetch(200, rec),
    timeoutMs: 20, writeTimeoutMs: 60000,
  });
  const got = await store.load();
  assert.equal(got, null, 'a timed-out read returns null');
  assert.equal(rec.aborted, 1, 'the read was aborted by the SHORT ceiling, not the write budget');
  assert.equal(store.readFailed(), true, 'and fails CLOSED so save() refuses to overwrite');
});

test('an ordinary write completes under the DEFAULT budgets (smoke)', async () => {
  // ★ Honest about its own reach: this does NOT discriminate the two budgets. A 60ms write
  // completes under either the read ceiling or the write budget, so it passes against the
  // un-fixed code too. Separating them here would need a stubbed delay longer than the read
  // ceiling — seconds of wall clock in a unit suite — so tests 1 and 2 carry that proof
  // (both verified to fail against the shared-timeout version) and this stays a smoke check
  // that the defaults are wired up at all and nothing throws on the happy path.
  const rec = {};
  const store = createPersistStore({ token: 't', gistId: 'g', fetchImpl: slowFetch(60, rec) });
  store.save({ a: 1 });
  await settled(() => rec.completed || rec.aborted);
  assert.equal(rec.completed, 1, 'a normal write completes under the defaults');
  assert.ok(!rec.aborted, 'and is not aborted');
  assert.equal(store.writeFailed(), false, 'so writeFailed stays clear');
});
