/**
 * Minimal RFC4180 CSV parser (quoted fields, embedded commas/newlines,
 * doubled-quote escaping) — no dependency exists in this workspace and the
 * only consumer (sources/nga.ts) needs nothing fancier. Reads the whole file
 * into memory (NGA's objects.csv is ~82 MB — fine for a one-shot pipeline
 * script; not used per-request).
 */

/** Parse CSV text into rows of raw string cells (no header handling). */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r") {
      // swallow; \n (bare or following \r) ends the row
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Parse CSV text into an array of header-keyed records (first row = header). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];
  const header = rows[0];
  const out: Record<string, string>[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length === 1 && r[0] === "") continue; // trailing blank line
    const rec: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) rec[header[j]] = r[j] ?? "";
    out.push(rec);
  }
  return out;
}
