import type { ObjectRow } from "../sources/types.ts";

/**
 * vocab.json: distinct classifications + cultures with counts (descending).
 * Feeds the interpret tier's vocabulary prompt (server/src/vocab.ts reads the
 * same facts from the built DB; this snapshot is the pipeline-side record).
 */
export function buildVocab(rows: ObjectRow[]): {
  classifications: Record<string, number>;
  cultures: Record<string, number>;
} {
  const count = (key: "classification" | "culture") => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const v = r[key];
      if (v) m.set(v, (m.get(v) ?? 0) + 1);
    }
    return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
  };
  return { classifications: count("classification"), cultures: count("culture") };
}
