// Golden-case drafting helper: deterministically samples a museum's rows from
// the merged artifact and emits DRAFT autocomplete cases (distinctive title
// tokens of highlights + top-classification exemplars) to stdout as JSON.
// The output is a starting point for MANUAL curation — full/llm cases
// (natural-language phrasings, vocabulary leaps) are always hand-written;
// see data/evals/aic/search-cases.json for the authored shape.
//
// Usage: node data/evals/make-goldens.mjs <museumId> [dbPath] [count]
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const p = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const Database = createRequire(p("../package.json"))("better-sqlite3");

const museum = process.argv[2];
if (!museum) {
  console.error("usage: node make-goldens.mjs <museumId> [dbPath] [count]");
  process.exit(2);
}
const db = new Database(process.argv[3] ?? p("../met.sqlite"), { readonly: true });
const count = Number(process.argv[4] ?? 12);

// Deterministic "random": order by a stable hash of objectID.
const sample = (where, n) =>
  db
    .prepare(
      `SELECT objectID, title, artist, classification FROM objects
       WHERE museum = ? AND ${where} ORDER BY (objectID * 2654435761) % 4294967296 LIMIT ?`,
    )
    .all(museum, n);

// Distinctive query = the two rarest title tokens (by corpus df from vocab).
const df = new Map(db.prepare("SELECT term, df FROM vocab").all().map((r) => [r.term, r.df]));
const fold = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const distinctiveQuery = (title) => {
  const toks = [...new Set(fold(title).split(/[^a-z0-9]+/).filter((t) => t.length >= 3))];
  toks.sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0));
  return toks.slice(0, 2).join(" ");
};

const drafts = [];
for (const r of sample("isHighlight = 1", Math.ceil(count * 0.7))) {
  const q = distinctiveQuery(r.title);
  if (q) drafts.push({ query: q, tier: "autocomplete", expectObjectIDs: [r.objectID], note: `DRAFT highlight: "${r.title}" (${r.artist})` });
}
for (const r of sample("isHighlight = 0 AND title != ''", count - drafts.length)) {
  const q = distinctiveQuery(r.title);
  if (q) drafts.push({ query: q, tier: "autocomplete", expectObjectIDs: [r.objectID], note: `DRAFT random: "${r.title}" (${r.artist})` });
}
console.log(JSON.stringify({ description: `DRAFT cases for ${museum} — curate before use`, cases: drafts }, null, 2));
