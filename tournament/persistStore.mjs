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
  timeoutMs = 8000,
} = {}) {
  const enabled = !!(token && gistId && fetchImpl);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'paper-trade-india',
  };

  // A best-effort per-request timeout so a HUNG GitHub fetch can never block the boot path
  // (init() awaits load()) or stall a save. Uses an UNREF'd timer so it never keeps the
  // process alive (matters for tests + a clean shutdown). Returns undefined if AbortController
  // is somehow unavailable (then the request simply has no timeout — no worse than before).
  const abortAfter = (ms) => {
    try {
      const c = new AbortController();
      const t = setTimeout(() => { try { c.abort(); } catch { /* ignore */ } }, ms);
      if (t && typeof t.unref === 'function') t.unref();
      return c.signal;
    } catch {
      return undefined;
    }
  };

  // A single blob awaiting a flush, plus an in-flight guard so two saves can never
  // PATCH concurrently. Bursts coalesce to the LATEST snapshot (the tournament only
  // ever wants its newest state persisted), and the final state is always flushed.
  let pending = null;
  let flushing = false;

  // Did the last load() attempt FAIL TO READ the store — as opposed to reading it fine
  // and finding nothing there?
  //
  // Collapsing those two cases into a bare `null` was a DATA-LOSS bug. A transient 503,
  // an 8s timeout, or a >1MB truncated read all looked identical to "this gist is empty",
  // so the tournament stamped a FRESH forward clock and then save()d that empty state
  // straight over the only durable copy — wiping the live closes, the deploy date and the
  // append-only advisor log. And it was self-perpetuating: the next boot faithfully
  // restored the wiped blob. On an ephemeral-disk host there is no second copy to recover
  // from.
  //
  // So the store FAILS CLOSED: while this flag is set it refuses to WRITE. An unreadable
  // store is never overwritten. A genuinely empty gist (the first ever boot) reads fine,
  // leaves the flag clear, and stays writable. The flag lives for this process only — the
  // next boot retries the read from scratch.
  let readFailed = false;
  let warnedReadFailed = false;

  // Say WHY a read failed, once, on the host's log. The store going unreadable is silent by
  // design (fail-closed, best-effort) and that silence once hid an expired token for three
  // WEEKS — the forward record simply stopped accumulating and nothing anywhere said so. The
  // HTTP status is the entire diagnosis, so name it and what it means. NEVER logs the token.
  const explainStatus = (status) => {
    if (status === 401) return 'the token is expired or revoked';
    if (status === 403) return 'the token lacks the gist scope, or is rate-limited';
    if (status === 404) return 'the gist id is wrong, or this token cannot see that gist';
    return 'unexpected status';
  };
  const warnRead = (why) => {
    console.warn(`persistStore: could not READ the remote store (${why}). The forward record + advisor log are NOT being restored or saved, and will reset on every restart until this is fixed. Nothing already stored is lost (writes are refused while unreadable).`);
  };

  // Fetch the persisted blob (or null if unconfigured / missing / unreadable).
  async function load() {
    if (!enabled) return null;
    readFailed = false;
    try {
      const res = await fetchImpl(`${GH_API}/gists/${gistId}`, { headers, signal: abortAfter(timeoutMs) });
      if (!res || !res.ok) {
        readFailed = true;
        warnRead(res ? (Number.isFinite(res.status) ? `HTTP ${res.status} — ${explainStatus(res.status)}` : 'the response carried no status') : 'no response');
        return null;
      }
      const gist = await res.json();
      const file = gist && gist.files && gist.files[filename];
      // No file (or no content) is an HONEST empty read — a gist we created but never
      // wrote to. That is the first-boot bootstrap case, and it must stay writable.
      if (!file || typeof file.content !== 'string') return null;
      // The Gist API TRUNCATES a file's `content` at 1MB on read (sets file.truncated and
      // serves the full file only via raw_url). Our state blob crosses 1MB after ~1 year of
      // forward bars, so a bare JSON.parse(file.content) would then choke on a HALF file and
      // the whole forward record would silently fail to restore. When truncated, fetch the
      // full content via raw_url (served up to ~10MB ≈ many years) before parsing.
      let content = file.content;
      if (file.truncated && file.raw_url) {
        const raw = await fetchImpl(file.raw_url, { headers, signal: abortAfter(timeoutMs) });
        // A failed raw fetch leaves `content` as the HALF file — parsing that would throw
        // below and (before the fail-closed flag) looked like an empty store. It is a read
        // failure, not an empty store.
        if (!raw || !raw.ok || typeof raw.text !== 'function') {
          readFailed = true;
          warnRead(raw && raw.status ? `HTTP ${raw.status} fetching the full (>1MB) file` : 'the full (>1MB) file could not be fetched');
          return null;
        }
        content = await raw.text();
      }
      const blob = JSON.parse(content);
      if (blob === null) return null; // the file literally holds `null` — an honest empty read
      if (typeof blob !== 'object') { readFailed = true; warnRead('the stored file is not an object'); return null; } // junk we don't understand: don't clobber it
      return blob;
    } catch (e) {
      readFailed = true; // network/abort/parse — we do NOT know what the store holds
      warnRead(e && e.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : (e && e.message) || 'network or parse error');
      return null;
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
          const res = await fetchImpl(`${GH_API}/gists/${gistId}`, {
            method: 'PATCH',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ files: { [filename]: { content: JSON.stringify(blob) } } }),
            signal: abortAfter(timeoutMs),
          });
          // Drain the response body so the underlying socket is released back to the pool
          // (an un-consumed fetch body can otherwise keep the connection open under undici).
          if (res && typeof res.text === 'function') await res.text().catch(() => {});
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
    // FAIL CLOSED: we could not read the store this boot, so we do not know what is in it
    // — writing would replace a forward record we never saw. Local disk saves continue
    // (tournament.save() does those separately); the next boot retries the read.
    if (readFailed) {
      if (!warnedReadFailed) {
        warnedReadFailed = true;
        console.warn('persistStore: the remote store could not be READ this boot — refusing to overwrite it. The forward record is untouched; it will restore on the next successful boot.');
      }
      return;
    }
    try {
      pending = JSON.parse(JSON.stringify(blob));
    } catch {
      return; // an unserialisable blob can't be persisted; skip it silently
    }
    flush().catch(() => {}); // fire-and-forget; flush swallows internally, but guard defensively
  }

  return { enabled, load, save, flush, readFailed: () => readFailed };
}

export { createPersistStore, FILENAME };
