// ---------------------------------------------------------------------------
// cache.js
// A tiny in-memory cache with two important features:
//   1. TTL (time-to-live): a value is "fresh" only for a number of ms.
//   2. Stale fallback: if a live fetch fails, we can still hand back the LAST
//      good value (marked stale) instead of showing nothing.
//
// This is what lets us respect rate limits AND degrade gracefully when the
// unofficial NSE endpoints block us.
// ---------------------------------------------------------------------------

'use strict';

// Cap on distinct keys, so a flood of unique keys (e.g. attacker-supplied
// symbols) can't grow the cache without bound. The real app uses a tiny handful
// of keys; this is purely a safety ceiling.
const MAX_ENTRIES = 500;

class TtlCache {
  constructor(maxEntries = MAX_ENTRIES) {
    // key -> { value, storedAt }
    this.store = new Map();
    this.maxEntries = maxEntries;
  }

  // Return the cached value only if it is still within `ttlMs`. Otherwise null.
  getFresh(key, ttlMs) {
    const entry = this.store.get(key);
    if (!entry) return null;
    const age = Date.now() - entry.storedAt;
    return age <= ttlMs ? entry.value : null;
  }

  // Return the last stored value regardless of age (or null if we never had one).
  getStale(key) {
    const entry = this.store.get(key);
    return entry ? entry.value : null;
  }

  // How old (ms) is the cached value? Infinity if we have nothing. Clamped to
  // >= 0 so a backward clock step (NTP correction, manual change) never yields a
  // negative age that we'd report to the client as staleAgeMs.
  ageOf(key) {
    const entry = this.store.get(key);
    return entry ? Math.max(0, Date.now() - entry.storedAt) : Infinity;
  }

  set(key, value) {
    // Bound memory: if this is a NEW key and we're at capacity, evict the
    // oldest entry (Map preserves insertion order). Re-setting an existing key
    // doesn't grow the map, so it skips eviction.
    if (!this.store.has(key) && this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      this.store.delete(oldest);
    }
    this.store.set(key, { value, storedAt: Date.now() });
    return value;
  }
}

module.exports = { TtlCache };
