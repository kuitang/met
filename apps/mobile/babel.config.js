module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      [
        'babel-preset-expo',
        {
          web: {
            // @sqlite.org/sqlite-wasm's ESM references `import.meta`, which
            // is a parse error in metro's classic-script web bundles. The
            // polyfill rewrites it to globalThis.__ExpoImportMetaRegistry;
            // the referencing code paths are never taken because
            // src/data/sqlite.web.ts passes an explicit `locateFile`.
            transformImportMeta: true,
          },
        },
      ],
    ],
  };
};
