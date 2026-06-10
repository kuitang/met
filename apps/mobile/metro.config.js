// Learn more: https://docs.expo.dev/guides/customizing-metro/
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

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
