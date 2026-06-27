// ---------------------------------------------------------------------------
// routes/market.js
// All read-only market-data API endpoints live here. They share one origin
// with the frontend (same Express server), so the browser never hits CORS.
//
// Endpoints:
//   GET /api/status                         -> market state + data source health
//   GET /api/quote?symbol=RELIANCE          -> single quote
//   GET /api/history?symbol=RELIANCE&interval=1d&range=1mo
//   GET /api/expiries?symbol=NIFTY
//   GET /api/option-chain?symbol=NIFTY&expiry=26-Jun-2026
// ---------------------------------------------------------------------------

'use strict';

const express = require('express');
const provider = require('../dataSources');
const { getMarketState, HOLIDAYS } = require('../marketHours');

const router = express.Router();

// Wrap an async handler so any thrown error becomes a clean JSON 500 instead
// of crashing the process.
function safe(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  };
}

// Require a single non-empty ?symbol= and return it upper-cased, else send 400.
// A duplicated (?symbol=A&symbol=B) or nested (?symbol[x]=1) param arrives as an
// array/object; coercing it would build a junk ticker like "A,B" that then gets
// fetched and cached, so reject non-strings outright.
function requireSymbol(req, res) {
  const raw = req.query.symbol;
  if (raw != null && typeof raw !== 'string') {
    res.status(400).json({ error: '?symbol= must be a single value' });
    return null;
  }
  const symbol = (raw || '').toString().trim().toUpperCase();
  if (!symbol) {
    res.status(400).json({ error: 'Missing required ?symbol= parameter' });
    return null;
  }
  return symbol;
}

// Read an optional string query param, ignoring array/object values (which
// would otherwise stringify into junk and pollute the cache key).
function strParam(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

router.get('/status', (req, res) => {
  res.json({
    market: getMarketState(),
    holidays: HOLIDAYS,
    health: provider.getHealth(),
    serverTime: Date.now(),
  });
});

router.get(
  '/quote',
  safe(async (req, res) => {
    const symbol = requireSymbol(req, res);
    if (!symbol) return;
    res.json(await provider.getQuote(symbol));
  })
);

router.get(
  '/history',
  safe(async (req, res) => {
    const symbol = requireSymbol(req, res);
    if (!symbol) return;
    const interval = strParam(req.query.interval, '1d');
    const range = strParam(req.query.range, '1mo');
    res.json(await provider.getHistory(symbol, { interval, range }));
  })
);

router.get(
  '/expiries',
  safe(async (req, res) => {
    const symbol = requireSymbol(req, res);
    if (!symbol) return;
    res.json(await provider.getExpiries(symbol));
  })
);

router.get(
  '/option-chain',
  safe(async (req, res) => {
    const symbol = requireSymbol(req, res);
    if (!symbol) return;
    const expiry = strParam(req.query.expiry, undefined);
    res.json(await provider.getOptionChain(symbol, expiry));
  })
);

module.exports = router;
