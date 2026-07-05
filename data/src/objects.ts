/**
 * Objects pipeline driver: full hydration of a museum's on-view catalog into
 * data/snapshots/ via its source adapter (data/src/sources/{id}.ts).
 *
 * Usage: tsx src/objects.ts [--museum met] [--limit N]
 *
 * Resumable: each source keeps a resume cache under data/raw/{museum}/ so an
 * interrupted run (WAF block, crash) restarts where it left off.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceFor } from "./sources/registry.ts";

const SNAPSHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "snapshots");

async function main(): Promise<void> {
  const argv = process.argv;
  const museumIdx = argv.indexOf("--museum");
  const museum = museumIdx >= 0 ? argv[museumIdx + 1] : "met";
  const limitIdx = argv.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : undefined;

  const source = sourceFor(museum);
  await source.fullFetch({ snapDir: SNAPSHOT_DIR, limit });
}

main();
