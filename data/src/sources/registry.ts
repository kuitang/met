/**
 * The museum registry — single source of truth for which museums exist, their
 * display identity, and their source adapters. The data pipelines, the server
 * manifest endpoint, and (via shard meta) the client all derive from here.
 *
 * D1 scope: Met only. New museums land as sources/{id}.ts + one entry here.
 */
import type { MuseumSource } from "./types.ts";
import { metSource } from "./met.ts";

export interface MuseumInfo {
  id: string;
  name: string;
  shortName: string;
}

export const MUSEUMS: MuseumInfo[] = [
  { id: "met", name: "The Metropolitan Museum of Art", shortName: "The Met" },
];

const SOURCES: Record<string, MuseumSource> = {
  met: metSource,
};

export function sourceFor(id: string): MuseumSource {
  const s = SOURCES[id];
  if (!s) throw new Error(`unknown museum source: ${id} (known: ${Object.keys(SOURCES).join(", ")})`);
  return s;
}
