// resetGuard.js — the confirmation rule for POST /api/tournament/reset.
//
// WHY THIS IS ITS OWN MODULE
// --------------------------
// It started life inline in server.js, and the test for it re-implemented the same comparison
// by hand. That is the project's own "a test that copies a magic number proves only that the
// code equals itself" rule, applied to LOGIC instead of a constant: renaming the
// query parameter, or flipping `!==` to `===`, would have left every test green while the route
// either 400'd forever in production or stood wide open to exactly the drive-by POST the guard
// exists to stop. Extracting it means the route and the test exercise the SAME code, including
// the parameter NAME — the route now forwards `req.query` wholesale, so there is no second place
// where the name could drift.
//
// WHAT IT PROTECTS
// ----------------
// A reset restarts `deployedAt` and clears the live advisor suggestion log. The log itself is
// ARCHIVED rather than destroyed, but the 90-day "track record before trust" CLOCK restarts, and
// that clock cannot be recomputed from data — only waited out, at one trading day per trading
// day, with missed days never back-filled (by design: reconstructing one later would be
// hindsight, the single thing the log exists to rule out). So a stray POST to a public URL could
// throw away the one artifact in this project that only TIME can produce.
//
// WHY A TOKEN AND NOT A PASSWORD
// ------------------------------
// The caller must echo the CURRENT `deployedAt`, which it can only learn by first reading
// GET /api/tournament. That:
//   * refuses blind POSTs and endpoint scanners outright — they never read the state;
//   * makes a double-click or a replayed request stale by construction, since the value changes
//     on every reset;
//   * doubles as an optimistic-concurrency check: you are asserting WHICH run you mean to end;
//   * changes nothing about how the site is used — the control panel already holds the payload.
// It is explicitly NOT a defence against someone determined who reads the API first. That is what
// APP_PASSWORD is for (it gates the whole site when set). This closes the accidental and the
// automated cases, which are the realistic ones for an obscure URL.

/**
 * Decide whether a reset request may proceed.
 *
 * @param {object|null} standings  the CURRENT board (tournament.getStandings()), or null/undefined
 *                                 when the tournament has not published one yet.
 * @param {object} query           the request's query object, forwarded verbatim from Express so
 *                                 the parameter NAME is part of what the tests exercise.
 * @returns {{ok: true} | {ok: false, status: number, error: string}}
 */
function checkResetConfirm(standings, query = {}) {
  // No board yet means nothing to confirm AGAINST. Unreachable through the normal boot path
  // (server.js only assigns `tournament` after init() resolves, and init() publishes standings),
  // but a distinct status and message beats reporting it as a failed confirmation.
  const expected = standings && standings.deployedAt;
  if (!expected) {
    return { ok: false, status: 503, error: 'Tournament is still warming up — try again in a moment.' };
  }
  const got = typeof query.confirm === 'string' ? query.confirm : '';
  // Compare as STRINGS on both sides: `deployedAt` is a Date.now() number server-side and always
  // arrives as a string over the query, so coercing one way only would never match.
  if (String(expected) !== got) {
    return {
      ok: false,
      status: 400,
      error: 'Reset needs confirmation. Reload the board and try again — this guards the forward record (the advisor’s trust clock cannot be rebuilt except by waiting).',
    };
  }
  return { ok: true };
}

module.exports = { checkResetConfirm };
