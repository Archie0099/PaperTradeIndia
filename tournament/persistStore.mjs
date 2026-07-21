// ---------------------------------------------------------------------------
// tournament/persistStore.mjs
// OPTIONAL remote persistence for the tournament's live-forward state, so it
// survives a redeploy on an EPHEMERAL-DISK host (Render's free tier wipes
// data/tournament.json on every deploy/restart — which is why the live-forward
// record never accumulates and liveBars resets to 0 on each ship).
//
// It reads/writes a single SECRET GitHub Gist via the global `fetch`, so it stays
// free (a Gist costs nothing), adds ZERO new runtime dependencies (Node 18+ global
// fetch only), and never touches money or places an order — it only moves the
// simulated tournament state.
//
// Configuration lives ONLY in the host environment, never in code:
//   PERSIST_GIST_ID     the id of a secret Gist you created
//   PERSIST_GIST_TOKEN  a fine-grained PAT with ONLY the "gists" scope
// When either is unset (local dev, tests) the store is a STRICT NO-OP:
//   load() -> null, save() -> nothing, enabled === false — so the tournament
//   behaves BYTE-IDENTICALLY to before. Everything here is best-effort: any
//   network/parse failure is swallowed (a missed save just means that bar isn't
//   durably stored yet — exactly the current local-disk-only behaviour).
// ---------------------------------------------------------------------------

const GH_API = 'https://api.github.com';
const FILENAME = 'tournament-state.json';

function createPersistStore({
  token = (typeof process !== 'undefined' && process.env && process.env.PERSIST_GIST_TOKEN) || '',
  gistId = (typeof process !== 'undefined' && process.env && process.env.PERSIST_GIST_ID) || '',
  filename = FILENAME,
  fetchImpl = (typeof fetch === 'function' ? fetch : null),
} = {}) {
  const enabled = !!(token && gistId && fetchImpl);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'paper-trade-india',
  };

  // A single blob awaiting a flush, plus an in-flight guard so two saves can never
  // PATCH concurrently. Bursts coalesce to the LATEST snapshot (the tournament only
  // ever wants its newest state persisted), and the final state is always flushed.
  let pending = null;
  let flushing = false;

  // Fetch the persisted blob (or null if unconfigured / missing / unreadable).
  async function load() {
    if (!enabled) return null;
    try {
      const res = await fetchImpl(`${GH_API}/gists/${gistId}`, { headers });
      if (!res || !res.ok) return null;
      const gist = await res.json();
      const file = gist && gist.files && gist.files[filename];
      if (!file || typeof file.content !== 'string') return null;
      const blob = JSON.parse(file.content);
      return blob && typeof blob === 'object' ? blob : null;
    } catch {
      return null; // best-effort: a fresh forward clock is an acceptable fallback
    }
  }

  // Drain `pending` to the Gist. Coalesces: if more saves land while a PATCH is in
  // flight, they update `pending` and this loop picks up the newest before returning.
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      while (pending != null) {
        const blob = pending;
        pending = null;
        try {
          await fetchImpl(`${GH_API}/gists/${gistId}`, {
            method: 'PATCH',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ files: { [filename]: { content: JSON.stringify(blob) } } }),
          });
        } catch {
          /* best-effort — drop this attempt; the next save() will retry with fresher state */
        }
      }
    } finally {
      flushing = false;
    }
  }

  // Fire-and-forget: snapshot the state NOW (the caller mutates `state` in place, so we
  // must deep-copy before the async PATCH serialises it) and kick a flush. Never awaited
  // by the tournament — persistence must never block the board.
  function save(blob) {
    if (!enabled) return;
    try {
      pending = JSON.parse(JSON.stringify(blob));
    } catch {
      return; // an unserialisable blob can't be persisted; skip it silently
    }
    flush();
  }

  return { enabled, load, save, flush };
}

export { createPersistStore, FILENAME };
