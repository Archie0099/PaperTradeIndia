// ---------------------------------------------------------------------------
// server.js
// The entry point. It does two jobs:
//   1. Serves the static frontend in /public.
//   2. Mounts the read-only market-data API under /api.
// Frontend and API share one origin/port, so there are no CORS headaches.
//
// This server NEVER places real orders. It only relays public market data.
// All trading is simulated in the browser with virtual money.
//
// Run:  npm install   then   npm start
// ---------------------------------------------------------------------------

'use strict';

require('dotenv').config(); // load .env (optional) into process.env
const path = require('path');
const express = require('express');

const config = require('./src/config');
const marketRoutes = require('./src/routes/market');

const app = express();

// Tiny request logger so you can see what the frontend is asking for.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// --- Optional password lock ------------------------------------------------
// If APP_PASSWORD is set (e.g. as an environment variable on the host), the
// whole site requires HTTP Basic auth — so only you can open it. Unset (local
// dev) = open, no prompt. /api/status stays open so a free uptime-pinger can
// keep the service awake without knowing the password. The password lives ONLY
// in the host's env, never in the code/repo.
const APP_PASSWORD = process.env.APP_PASSWORD;
const APP_USER = process.env.APP_USER || 'admin';
if (APP_PASSWORD) {
  app.use((req, res, next) => {
    if (req.path === '/api/status') return next(); // allow the uptime pinger
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && encoded) {
      // Split on the FIRST colon only — a password may legally contain colons
      // (RFC 7617); plain split(':') would truncate it and silently lock you out.
      const decoded = Buffer.from(encoded, 'base64').toString();
      const sep = decoded.indexOf(':');
      const user = sep < 0 ? decoded : decoded.slice(0, sep);
      const pass = sep < 0 ? '' : decoded.slice(sep + 1);
      if (user === APP_USER && pass === APP_PASSWORD) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Paper Trade India"');
    return res.status(401).send('Authentication required.');
  });
  console.log('Password lock ENABLED (APP_PASSWORD is set).');
}

// Market-data API.
app.use('/api', marketRoutes);

// --- Live tournament (autonomous paper-trading bots) -----------------------
// Loaded as an ES module (it reuses the browser simulation engine + the
// backtester). The route is registered NOW, before the /api 404 catch-all
// below, so it always resolves; the instance is populated asynchronously and
// returns 503 until it has warmed up. VIRTUAL money only — no real orders.
let tournament = null;
app.get('/api/tournament', (req, res) => {
  if (!tournament) return res.status(503).json({ error: 'Tournament is warming up' });
  res.json(tournament.getStandings());
});
// One bot's FULL history (re-runs just that bot with trade recording) — powers the
// "click a bot to see what/when it bought + every trade's P&L" detail view. Read-only.
// A cache MISS runs a backtest, so a lenient min-interval caps a burst of distinct-id
// requests (human clicking is well under this; repeated clicks on the SAME bot are
// already free — getBotDetail memoises per roster+live state).
let lastBotDetail = 0;
app.get('/api/tournament/bot', (req, res) => {
  if (!tournament) return res.status(503).json({ error: 'Tournament is warming up' });
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  // The min-interval only needs to defang a burst of distinct-id BACKTESTS. A cache HIT
  // (a repeat/fast click on the same already-computed bot) is free, so serve it without
  // the gate — otherwise a normal double-click could get a spurious 429.
  const cached = tournament.detailIsCached(id);
  const now = Date.now();
  if (!cached) {
    if (now - lastBotDetail < 150) return res.status(429).json({ error: 'Too fast — try again in a moment.' });
    lastBotDetail = now;
  }
  try {
    const detail = tournament.getBotDetail(id);
    if (!detail || detail.ok === false) return res.status(404).json({ error: (detail && detail.error) || 'No such bot' });
    res.json(detail);
  } catch (e) {
    // Keep the response a clean JSON error (not Express's default HTML 500) so the UI
    // shows a soft "couldn't load" rather than a parse failure.
    res.status(500).json({ error: 'Could not load bot detail right now.' });
  }
});
// Light rate-limit on the state-MUTATING tournament POSTs. `evolve` is CPU-heavy
// (it breeds 16 challengers and re-backtests the roster synchronously), so this
// stops a burst from pinning the event loop / wiping the shared board. Human
// clicks are well under this; the daily auto-evolve bypasses it (it calls the
// tournament directly, not over HTTP).
let lastTournMutate = 0;
function tournRateLimit(req, res, next) {
  if (!tournament) return res.status(503).json({ error: 'Tournament is warming up' });
  const now = Date.now();
  if (now - lastTournMutate < 600) return res.status(429).json({ error: 'Too fast — try again in a moment.' });
  lastTournMutate = now;
  next();
}
app.post('/api/tournament/evolve', tournRateLimit, (req, res) => {
  const result = tournament.runGeneration();
  res.json({ ...result, standings: tournament.getStandings() });
});
// Control-panel actions (no request body needed — keeps the server middleware-light).
app.post('/api/tournament/reset', tournRateLimit, (req, res) => {
  res.json({ ...tournament.reset(), standings: tournament.getStandings() });
});
app.post('/api/tournament/add', tournRateLimit, (req, res) => {
  res.json({ ...tournament.addFromPool(), standings: tournament.getStandings() });
});
app.post('/api/tournament/remove', tournRateLimit, (req, res) => {
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  res.json({ ...tournament.removeBot(id), standings: tournament.getStandings() });
});
(async () => {
  try {
    const { createTournament } = await import('./tournament/tournament.mjs');
    // BREEDING OFF (by design): the live board shows only the CURATED seed line-up, not
    // unproven in-sample genetic-algorithm mutations. The evolution machinery is kept intact
    // behind this flag — set evolutionEnabled:true here to resume the self-evolving tournament.
    const t = await createTournament({ evolutionEnabled: false });
    await t.init();
    tournament = t;
    t.tick().catch(() => {}); // advance once at boot...
    setInterval(() => t.tick().catch(() => {}), 10 * 60 * 1000); // ...then poll for a new daily bar
    // The INTRADAY track: poll for fresh 60-min bars. It self-gates on the NSE session
    // being open, so off-hours/weekends it's a cheap no-op (no wasted network).
    t.tickIntraday().catch(() => {});
    setInterval(() => t.tickIntraday().catch(() => {}), 10 * 60 * 1000);
    // Daily auto-evolve — only when breeding is enabled (skipped while it's off).
    if (t.evolutionEnabled) setInterval(() => { try { t.runGeneration(); } catch {} }, 24 * 3600 * 1000);
    console.log(`Tournament started with ${t.botCount()} bots (generation ${t.getStandings().generation}; breeding ${t.evolutionEnabled ? 'ON' : 'OFF'}).`);
  } catch (err) {
    console.error('Tournament failed to start:', (err && err.message) || err);
  }
})();

// Static frontend (index.html, css, js). Served from the same origin.
app.use(express.static(path.join(__dirname, 'public')));

// Anything else under /api that we didn't define = clear JSON 404.
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Unknown API route: ${req.originalUrl}` });
});

// Final error handler (keeps the process alive on unexpected errors).
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(config.port, () => {
  // On a cloud host (e.g. Render) show the real public URL; locally show localhost.
  const publicUrl = process.env.RENDER_EXTERNAL_URL;
  console.log('-----------------------------------------------------------');
  console.log(' Paper Trade India  (SIMULATION ONLY — no real orders)');
  if (publicUrl) console.log(` Live at:  ${publicUrl}`);
  else console.log(` Open your browser at:  http://localhost:${config.port}`);
  console.log('-----------------------------------------------------------');
});
