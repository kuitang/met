/**
 * Shared parser for the committed Louvre plan JSONs (data/raw/louvre/plan/
 * salles_{-1,0,1,2}.json) — the salle-code ground truth that geometry-osm.ts
 * matches OSM rooms against and evals-louvre.ts audits reachability with.
 *
 * Replicates sources/louvre.ts#loadMembership byte-for-byte in its dedupe
 * semantics (verified against the committed snapshots/galleries.json):
 *   - dedupe by internal room key across floor files, first floor seen wins
 *     (the two-level "Crypte d'Osiris" appears verbatim under -1 and 0);
 *   - merge by parsed gallery code ("186" spans two internal keys), joining
 *     titles with " / " and unioning ark sets; the first entry's floor wins.
 */
import fs from "node:fs";
import path from "node:path";

export const PLAN_FLOORS = ["-1", "0", "1", "2"] as const;

export interface PlanSalle {
  galleryNumber: string;
  title: string;
  wing: string;
  floor: string; // "-1" | "0" | "1" | "2"
  /** Distinct on-view arks listed in this salle (the plan IS the on-view roster). */
  arks: Set<string>;
}

/** "Salle 711 - Salle de la Joconde" -> "711"; "Salle 227 bis - …" -> "227bis";
 * no "Salle N" prefix -> the plan's internal numeric key (13 of 389). */
export function parseRoomCode(nom: string, internalKey: string): string {
  const m = nom.match(/^Salle\s+(\d+)(?:\s*(bis))?/i);
  return m ? m[1] + (m[2] ? "bis" : "") : internalKey;
}

export function loadPlanSalles(planDir: string): Map<string, PlanSalle> {
  const seenKeys = new Set<string>();
  const byCode = new Map<string, PlanSalle & { titles: Set<string> }>();
  for (const floor of PLAN_FLOORS) {
    const salles: Record<
      string,
      { nom?: string; aile?: string; etage?: string; oeuvres?: Array<{ alias?: string }> }
    > = JSON.parse(fs.readFileSync(path.join(planDir, `salles_${floor}.json`), "utf8"));
    for (const [key, s] of Object.entries(salles)) {
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const code = parseRoomCode(s.nom ?? "", key);
      let e = byCode.get(code);
      if (!e) {
        e = {
          galleryNumber: code,
          title: "",
          titles: new Set<string>(),
          wing: (s.aile ?? "").trim(),
          floor,
          arks: new Set<string>(),
        };
        byCode.set(code, e);
      }
      if (s.nom) e.titles.add(s.nom.trim());
      for (const o of s.oeuvres ?? []) {
        const m = o.alias?.match(/ark:\/53355\/(\w+)/);
        if (m) e.arks.add(m[1]);
      }
    }
  }
  const out = new Map<string, PlanSalle>();
  for (const [code, e] of byCode) {
    out.set(code, {
      galleryNumber: code,
      title: [...e.titles].join(" / "),
      wing: e.wing,
      floor: e.floor,
      arks: e.arks,
    });
  }
  return out;
}
