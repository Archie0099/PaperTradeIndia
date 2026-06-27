// ---------------------------------------------------------------------------
// api.js
// Thin wrapper around fetch() for our same-origin /api endpoints. Because the
// frontend and backend share one origin, there are no CORS issues here.
//
// Every function resolves to the parsed JSON, or throws an Error with a
// human-readable message that the UI can show in an error state.
// ---------------------------------------------------------------------------

async function getJson(url) {
  const res = await fetch(url);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Server returned a non-JSON response (HTTP ${res.status}).`);
  }
  if (!res.ok) throw new Error(body && body.error ? body.error : `Request failed (HTTP ${res.status}).`);
  return body;
}

// POST with no body (the tournament control actions use query params, not bodies).
async function postJson(url) {
  const res = await fetch(url, { method: 'POST' });
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Server returned a non-JSON response (HTTP ${res.status}).`);
  }
  if (!res.ok) throw new Error(body && body.error ? body.error : `Request failed (HTTP ${res.status}).`);
  return body;
}

const api = {
  status: () => getJson('/api/status'),
  quote: (symbol) => getJson(`/api/quote?symbol=${encodeURIComponent(symbol)}`),
  history: (symbol, interval = '1d', range = '1mo') =>
    getJson(`/api/history?symbol=${encodeURIComponent(symbol)}&interval=${interval}&range=${range}`),
  expiries: (symbol) => getJson(`/api/expiries?symbol=${encodeURIComponent(symbol)}`),
  optionChain: (symbol, expiry) =>
    getJson(
      `/api/option-chain?symbol=${encodeURIComponent(symbol)}` +
        (expiry ? `&expiry=${encodeURIComponent(expiry)}` : '')
    ),
  tournament: () => getJson('/api/tournament'),
  tournamentBot: (id) => getJson(`/api/tournament/bot?id=${encodeURIComponent(id)}`),
  evolveTournament: () => postJson('/api/tournament/evolve'),
  resetTournament: () => postJson('/api/tournament/reset'),
  addTournamentBot: () => postJson('/api/tournament/add'),
  removeTournamentBot: (id) => postJson(`/api/tournament/remove?id=${encodeURIComponent(id)}`),
};

export default api;
