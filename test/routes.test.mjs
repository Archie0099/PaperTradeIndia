// ---------------------------------------------------------------------------
// test/routes.test.mjs
// Integration tests for the Express market-data routes (src/routes/market.js).
// We mount the REAL router on a throwaway app on an ephemeral port and hit it
// over HTTP. Only the network-FREE paths are exercised (the /status endpoint
// and the 400 validation paths), so these are deterministic and offline-safe —
// no Yahoo/NSE call is ever made.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const marketRoutes = require('../src/routes/market.js');

// Start a fresh server for one test; returns { port, close }.
function startServer() {
  const app = express();
  app.use('/api', marketRoutes);
  // Mirror server.js's JSON 404 for unknown /api routes.
  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

async function getJson(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

test('/api/status returns market state + source health (no network)', async () => {
  const srv = await startServer();
  try {
    const { status, body } = await getJson(srv.port, '/api/status');
    assert.equal(status, 200);
    assert.ok(body.market && typeof body.market.state === 'string', 'has market.state');
    assert.equal(typeof body.market.isOpen, 'boolean');
    assert.ok(body.health && 'yahoo' in body.health && 'nse' in body.health, 'has health');
    assert.ok(Array.isArray(body.holidays), 'has holidays array');
    assert.equal(typeof body.serverTime, 'number');
  } finally {
    await srv.close();
  }
});

test('/api/quote with no ?symbol= is a 400 with a clear error', async () => {
  const srv = await startServer();
  try {
    const { status, body } = await getJson(srv.port, '/api/quote');
    assert.equal(status, 400);
    assert.match(body.error, /symbol/i);
  } finally {
    await srv.close();
  }
});

test('/api/quote with a duplicated ?symbol= is rejected, not turned into a junk ticker', async () => {
  const srv = await startServer();
  try {
    // ?symbol=A&symbol=B -> Express parses an array; must be a 400, not a
    // fetch of the bogus ticker "A,B".
    const { status, body } = await getJson(srv.port, '/api/quote?symbol=A&symbol=B');
    assert.equal(status, 400);
    assert.match(body.error, /single value/i);
  } finally {
    await srv.close();
  }
});

test('an unknown /api route returns a JSON 404', async () => {
  const srv = await startServer();
  try {
    const { status, body } = await getJson(srv.port, '/api/does-not-exist');
    assert.equal(status, 404);
    assert.ok(body.error);
  } finally {
    await srv.close();
  }
});
