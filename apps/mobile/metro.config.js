// Learn more: https://docs.expo.dev/guides/customizing-metro/
const { getDefaultConfig } = require('expo/metro-config');
const crypto = require('crypto');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// ROOT-CAUSE FIX for the "poisoned bundle" class of bug: babel-preset-expo
// inlines EXPO_PUBLIC_* values into transformed modules, but Metro's
// transform-cache key does not include them — so exporting with
// EXPO_PUBLIC_DATA=real and then =stub silently re-serves the real-mode
// transforms (measured 2026-06-11; previously worked around with
// `expo export -c`). Namespacing the cache by a hash of every EXPO_PUBLIC_*
// variable makes each env combination its own cache: correct AND still
// cached, dev server and exports alike.
const envFingerprint = crypto
  .createHash('sha256')
  .update(
    JSON.stringify(
      Object.entries(process.env)
        .filter(([k]) => k.startsWith('EXPO_PUBLIC_'))
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  )
  .digest('hex')
  .slice(0, 16);
config.cacheVersion = `${config.cacheVersion ?? '1'}-env-${envFingerprint}`;

// wasm as a metro asset: src/data/sqlite.web.ts ships
// @sqlite.org/sqlite-wasm's sqlite3.wasm through the asset pipeline
// (resolved to a URL with expo-asset, no committed binary).
config.resolver.assetExts.push('wasm');

// @sqlite.org/sqlite-wasm references its optional worker entry points via
// `new Worker(new URL('sqlite3-worker1.mjs', import.meta.url))`, which metro
// collects as dependencies it cannot resolve. The app uses the main-thread
// build only (src/data/sqlite.web.ts), so resolve them to empty modules.
const sqliteWasmWorkerStubs = new Set(['sqlite3-worker1.mjs', 'sqlite3-opfs-async-proxy.js']);
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (sqliteWasmWorkerStubs.has(moduleName)) return { type: 'empty' };
  return context.resolveRequest(context, moduleName, platform);
};

// Cross-origin isolation headers for prod parity only: the prod server sends
// COOP/COEP on everything (see server/src/index.ts), so the dev server must
// surface any breakage the same way. The web sqlite backend itself runs on
// the main thread and needs no SharedArrayBuffer.
config.server.enhanceMiddleware = (middleware) => {
  return (req, res, next) => {
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    middleware(req, res, next);
  };
};

module.exports = config;
