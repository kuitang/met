// Typo-tolerance eval runner for the fuzzy autocomplete path (typo-cases.json).
// Measures, against an arbitrary met.sqlite (argv[2]; defaults to data/met.sqlite):
//   - recall@8 over the typo cases (intended object in autocompleteFuzzy's top 8)
//   - false-positive rate over the negative controls (any rows = FP)
//   - exact-vs-fuzzy latency p50/p95 on BOTH shipped query runtimes:
//     better-sqlite3 (server/build) and @sqlite.org/sqlite-wasm (web client)
// Also asserts every typo case yields ZERO rows on the exact prefix path —
// a case the old code already handled belongs in search-cases.json instead.
// Run with Node >= 24 (native type stripping resolves the shared/search.ts import).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const p = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const { autocompleteFuzzy, buildAutocompleteQuery } = await import(p("../../shared/search.ts"));
const Database = createRequire(p("../package.json"))("better-sqlite3");

const DB_PATH = process.argv[2] ?? p("../met.sqlite");
const cases = JSON.parse(readFileSync(p("./typo-cases.json"), "utf8")).cases;

const matches = (rows, c) =>
  rows.some(
    (r) =>
      (c.expectObjectIDs?.includes(r.objectID) ?? false) ||
      (c.expectTitleContains !== undefined &&
        r.title.toLowerCase().includes(c.expectTitleContains.toLowerCase())) ||
      (c.expectArtistContains !== undefined &&
        r.artist.toLowerCase().includes(c.expectArtistContains.toLowerCase())),
  );

const pct = (n, d) => ((100 * n) / d).toFixed(0) + "%";
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

function evaluate(run, label, { quiet = false } = {}) {
  const typos = cases.filter((c) => c.class !== "negative");
  const negatives = cases.filter((c) => c.class === "negative");

  // correctness
  const failures = [];
  const byClass = {};
  for (const c of typos) {
    const exact = run(buildAutocompleteQuery(c.input).sql, buildAutocompleteQuery(c.input).params);
    if (exact.length > 0) failures.push(`NOT A FUZZY CASE (exact path returns rows): ${c.input}`);
    const rows = autocompleteFuzzy(run, c.input).slice(0, 8);
    const ok = matches(rows, c);
    const s = (byClass[c.class] ??= { pass: 0, total: 0 });
    s.total++;
    if (ok) s.pass++;
    else
      failures.push(
        `[${c.class}] ${JSON.stringify(c.input)}\n    top: ${rows.slice(0, 5).map((r) => `${r.objectID} "${r.title}" (${r.artist})`).join(" | ") || "(no rows)"}`,
      );
  }
  let fp = 0;
  const fpInputs = [];
  for (const c of negatives) {
    const rows = autocompleteFuzzy(run, c.input);
    if (rows.length > 0) {
      fp++;
      fpInputs.push(`${JSON.stringify(c.input)} -> ${rows[0].title}`);
    }
  }

  // latency: exact baseline = the same typo inputs through the exact path only
  // (what every keystroke pays today); fuzzy = the full corrected pipeline.
  const exactTimes = [];
  const fuzzyTimes = [];
  for (let rep = 0; rep < 5; rep++) {
    for (const c of typos) {
      const q = buildAutocompleteQuery(c.input);
      let t0 = performance.now();
      run(q.sql, q.params);
      exactTimes.push(performance.now() - t0);
      t0 = performance.now();
      autocompleteFuzzy(run, c.input);
      fuzzyTimes.push(performance.now() - t0);
    }
  }
  exactTimes.sort((a, b) => a - b);
  fuzzyTimes.sort((a, b) => a - b);

  const pass = Object.values(byClass).reduce((s, c) => s + c.pass, 0);
  const total = Object.values(byClass).reduce((s, c) => s + c.total, 0);
  console.log(`\n=== ${label} ===`);
  if (!quiet)
    for (const [cls, s] of Object.entries(byClass))
      console.log(`  [${cls}] ${s.pass}/${s.total} (${pct(s.pass, s.total)})`);
  console.log(`  recall@8: ${pass}/${total} (${pct(pass, total)})  target >= 85%`);
  console.log(`  negative false positives: ${fp}/${negatives.length} (${pct(fp, negatives.length)})  target <= 10%`);
  if (fpInputs.length) console.log(`    FPs: ${fpInputs.join("; ")}`);
  console.log(
    `  latency exact-path baseline: p50 ${quantile(exactTimes, 0.5).toFixed(2)} ms  p95 ${quantile(exactTimes, 0.95).toFixed(2)} ms`,
  );
  console.log(
    `  latency fuzzy path:          p50 ${quantile(fuzzyTimes, 0.5).toFixed(2)} ms  p95 ${quantile(fuzzyTimes, 0.95).toFixed(2)} ms  target p95 < 30 ms (wasm)`,
  );
  if (failures.length && !quiet) console.log(`\n  FAILURES:\n  ` + failures.join("\n  "));
  return { pass, total, fp, negatives: negatives.length, fuzzyP95: quantile(fuzzyTimes, 0.95) };
}

// ---- better-sqlite3 (server/build runtime) ---------------------------------
const raw = new Database(DB_PATH, { readonly: true });
const runNative = (sql, params) => raw.prepare(sql).all(...params);
const native = evaluate(runNative, "better-sqlite3 (native)");

// ---- @sqlite.org/sqlite-wasm (the shipped web client runtime) --------------
const sqlite3 = await (await import("@sqlite.org/sqlite-wasm")).default({
  print: () => {},
  printErr: () => {},
});
const bytes = new Uint8Array(readFileSync(DB_PATH)); // plain Uint8Array: allocFromTypedArray rejects Node Buffers
const wdb = new sqlite3.oo1.DB();
const ptr = sqlite3.wasm.allocFromTypedArray(bytes);
const rc = sqlite3.capi.sqlite3_deserialize(
  wdb.pointer,
  "main",
  ptr,
  bytes.length,
  bytes.length,
  sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_READONLY,
);
if (rc !== 0) throw new Error(`sqlite3_deserialize rc=${rc}`);
const runWasm = (sql, params) =>
  wdb.selectObjects(sql, params.length ? [...params] : undefined);
const wasm = evaluate(runWasm, "sqlite-wasm (web client)", { quiet: true });
wdb.close();

const ok =
  native.pass / native.total >= 0.85 &&
  wasm.pass / wasm.total >= 0.85 &&
  native.fp / native.negatives <= 0.1 &&
  wasm.fp / wasm.negatives <= 0.1 &&
  wasm.fuzzyP95 < 30;
console.log(`\n${ok ? "ALL TARGETS MET" : "TARGETS MISSED"}`);
process.exit(ok ? 0 : 1);
