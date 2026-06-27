// ---------------------------------------------------------------------------
// test-helpers/dom-harness.mjs
//
// NOTE: this lives OUTSIDE the test/ directory on purpose. Node's built-in test
// runner treats every *.mjs file under a `test/` folder as a test file (a file
// with no test() calls would be counted as one empty test), so shared helpers
// must live elsewhere to keep `node --test` discovery clean.
//
// A tiny test harness that lets us drive the REAL frontend UI (the DOM event
// wiring and render functions in public/js/ui/*) from Node's built-in test
// runner — no browser, no build step.
//
// Why this exists
// ---------------
// The financial core (engine, options, strategies, market hours) is heavily
// unit-tested. The one untested category was the DOM/canvas UI: the code that
// reads form fields, builds tables, handles clicks, and renders numbers. This
// harness closes that gap by loading the real index.html into jsdom, then
// calling the real ui/*.js init/render functions against it and dispatching
// real DOM events.
//
// The three things jsdom does NOT give us out of the box, and how we handle
// them:
//   1. <canvas> 2D context  -> jsdom's getContext('2d') returns null, so the
//      hand-rolled charts (ui/chart.js) would throw. We install a no-op fake
//      2D context so a chart "draws" harmlessly.
//   2. localStorage          -> the engine and watchlist persist here. We give
//      them a fresh in-memory store per test (isolation).
//   3. Globals               -> the ui modules reference bare `document`,
//      `window`, `localStorage`, `alert`, `prompt`. In ES modules those resolve
//      to globalThis, so we assign them there.
//
// Each test calls setupDom() to get a brand-new document + a `makeApp()` factory
// that mirrors the `app` object app.js builds (engine + api + state + tabs +
// cross-module helpers), minus the polling timers. Tests then drive the real
// init/render functions and assert on the rendered DOM.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import { JSDOM } from 'jsdom';

import { Engine } from '../public/js/core/engine.js';
import { initTabs } from '../public/js/ui/tabs.js';
import { loadTicket } from '../public/js/ui/orders.js';

// The real markup the browser loads. Reading it (rather than hand-writing HTML)
// means our tests break if an element id the UI depends on is renamed/removed —
// which is exactly the kind of wiring bug we want to catch.
const INDEX_HTML = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

// A fake CanvasRenderingContext2D. Every drawing method is a no-op; the two
// methods chart.js reads a return value from are special-cased. A Proxy means
// we never have to enumerate the full canvas API — any method call is absorbed.
function fakeCanvasContext() {
  const props = {}; // holds assignable state like fillStyle, font, globalAlpha
  return new Proxy(props, {
    get(target, prop) {
      if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (prop === 'measureText') return () => ({ width: 0 });
      if (prop in target) return target[prop]; // a previously-set property
      return () => {}; // any drawing method -> no-op
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

// A canned /api client. Every method is async (like the real api.js) and
// returns plausible data. Pass `overrides` to replace any method per test
// (e.g. make optionChain reject to test the error state).
function makeApiStub(overrides = {}) {
  return {
    status: async () => ({
      market: { state: 'REGULAR', isOpen: true },
      health: { yahoo: { ok: true }, nse: { ok: true } },
      holidays: [],
    }),
    quote: async (symbol) => ({ symbol, ltp: 100, changePct: 1.25, source: 'live' }),
    history: async () => ({ candles: [{ t: 1, c: 100 }, { t: 2, c: 101 }, { t: 3, c: 99 }] }),
    expiries: async (symbol) => ({ symbol, expiries: ['26-Jun-2026', '31-Jul-2026'] }),
    optionChain: async (symbol, expiry) => syntheticChain(symbol, expiry),
    ...overrides,
  };
}

// A minimal but well-formed option-chain payload in the exact shape the UI's
// renderChain() expects: { symbol, underlying, expiry, expiries[], source,
// strikes[] } where each strike has ce/pe legs.
function syntheticChain(symbol = 'NIFTY', expiry = '26-Jun-2026') {
  const underlying = 23500;
  const strikes = [23400, 23450, 23500, 23550, 23600].map((strike) => ({
    strike,
    ce: { ltp: Math.max(1, underlying - strike) + 50, bid: 1, ask: 2, iv: 12.5, volume: 1000, oi: 5000, changeOi: 100 },
    pe: { ltp: Math.max(1, strike - underlying) + 50, bid: 1, ask: 2, iv: 13.0, volume: 900, oi: 4800, changeOi: -50 },
  }));
  return { symbol, underlying, expiry, expiries: ['26-Jun-2026', '31-Jul-2026'], source: 'synthetic', strikes };
}

// Build a fresh DOM + globals for one test. Returns helpers; call once per test.
function setupDom() {
  const dom = new JSDOM(INDEX_HTML, { url: 'http://localhost:3000/' });
  const { window } = dom;
  const { document } = window;

  // Make the page's canvases drawable (no-op).
  window.HTMLCanvasElement.prototype.getContext = () => fakeCanvasContext();

  // Fresh in-memory localStorage for this test (isolation between tests).
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };

  // Capture alert() text and script prompt() answers so account-action style
  // flows are testable and deterministic.
  const alerts = [];
  let promptAnswer = null; // tests set this via the returned `setPrompt`

  // Install everything the ui modules read off the global scope.
  globalThis.window = window;
  globalThis.document = document;
  globalThis.localStorage = localStorage;
  globalThis.alert = (msg) => alerts.push(String(msg));
  globalThis.prompt = () => promptAnswer;
  // Export download uses these; stub so a click doesn't blow up.
  globalThis.URL.createObjectURL = () => 'blob:stub';
  globalThis.URL.revokeObjectURL = () => {};

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  // Dispatch a DOM event of the given type on a node (real bubbling event).
  function fire(node, type, init = {}) {
    node.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true, ...init }));
  }
  // Set an <input>/<select> value then fire input+change so listeners react,
  // exactly like a user typing/selecting would.
  function setValue(node, value) {
    node.value = String(value);
    fire(node, 'input');
    fire(node, 'change');
  }
  // Submit a <form> (the handlers call preventDefault()).
  function submit(formSel) {
    fire($(formSel), 'submit');
  }
  // Run a function with timers stubbed out, so code that calls setInterval
  // (e.g. statusbar's clock) doesn't leak a live timer and hang the runner.
  function withoutTimers(fn) {
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = () => 0;
    try {
      return fn();
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  }

  // Build an `app` object mirroring app.js (engine + api + state + tabs +
  // cross-module helpers), minus the live polling loop. Tests can override any
  // piece (e.g. provide a spy pollQuotes / setActiveSymbol).
  function makeApp(overrides = {}) {
    const engine = new Engine();
    // The product DEFAULT account is now ₹1 crore (engine.js DEFAULT_CASH, so the personal
    // account matches the tournament bots / Auto-Pilot). The UI mechanics tests here are
    // calibrated to a ₹10 lakh account (e.g. "975,000 cash after a ₹25k buy"), so reset to
    // ₹10L for a stable, meaningful baseline — exactly like test/engine.test.mjs. The real
    // ₹1cr default is locked by engine.test.mjs + the real-app boot test (ui-bootstrap).
    engine.reset(1_000_000);
    const api = overrides.api || makeApiStub();
    const app = {
      engine,
      api,
      state: {
        quotes: {},
        watch: [],
        status: null,
        market: null,
        dataStale: false,
        activeSymbol: 'NIFTY',
        activeCandles: null,
        chainSymbol: 'NIFTY',
        chainExpiry: undefined,
        chain: null,
      },
    };
    // Real cross-module ticket loader (imported from the actual module).
    app.loadTicket = (inst, side, price, lots) => loadTicket(app, inst, side, price, lots);
    // Faithful stand-ins for the two helpers app.js defines inline. Tests that
    // care about their exact behaviour override them with spies.
    app.setActiveSymbol =
      overrides.setActiveSymbol ||
      (async (symbol) => {
        app.state.activeSymbol = symbol;
        $('#chart-symbol').textContent = symbol;
        $('#t-symbol').value = symbol;
      });
    app.pollQuotes = overrides.pollQuotes || (async () => {});
    // Real tab controller wired to the real nav buttons / panels.
    app.tabs = initTabs(overrides.onShow);
    return Object.assign(app, overrides.appExtras || {});
  }

  return {
    dom,
    window,
    document,
    $,
    $$,
    fire,
    setValue,
    submit,
    withoutTimers,
    makeApp,
    makeApiStub,
    syntheticChain,
    alerts,
    setPrompt: (v) => {
      promptAnswer = v;
    },
    store,
  };
}

export { setupDom, makeApiStub, syntheticChain, fakeCanvasContext };
