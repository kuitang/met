/**
 * The per-museum source-adapter seam. Every museum's collection data enters
 * the pipeline through a MuseumSource that writes the SAME snapshot files
 * (objects.json.gz + vocab.json + objects-meta.json) under its snapshot dir,
 * so build-db and the nightly job stay source-agnostic.
 *
 * D1 scope: the row shape matches today's Met artifact exactly; multi-museum
 * columns (museum, sourceId, license, …) arrive with schema v2.
 */

export interface ObjectRow {
  objectID: number;
  accession: string;
  title: string;
  artist: string;
  culture: string;
  period: string;
  classification: string;
  medium: string;
  tags: string; // '|'-joined terms
  galleryNumber: string;
  site: string; // globally-unique site id ("fifthAve" | "cloisters" for the Met)
  rotation: "permanent" | "exhibition";
  isHighlight: boolean;
  imageUrl: string;
  metadataDate: string;
  // ---- multi-museum fields (schema v2; optional in snapshots — build-db fills
  // defaults from the registry entry). The Met snapshot predates these.
  /** Museum-native record id (ark, "O9138", …). Default: String(objectID). */
  sourceId?: string;
  /** Sub-room location free text (V&A case "PL2", …). */
  locationNote?: string;
  /** Display-only English title when `title` is not English (Louvre). Also FTS-indexed. */
  titleAlt?: string;
  /** Per-record text license when it differs from the museum default. */
  license?: string;
  /** Per-record image-derivative license; "" = no derivatives allowed. */
  imageLicense?: string;
}

/**
 * Optional per-museum snapshot `galleries.json` for museums without geometry:
 * room labels/floors for the galleries table (else rows are synthesized from
 * distinct object galleryNumbers with NULL title/floor).
 */
export interface GalleryLabelRow {
  galleryNumber: string;
  site: string;
  title?: string;
  floor?: string;
}

export interface FullFetchOptions {
  /** Snapshot dir to read baselines from and write outputs to. */
  snapDir: string;
  /** Hydrate at most N records (spike/testing). */
  limit?: number;
}

export interface MuseumSource {
  id: string;
  /**
   * Full hydration: enumerate the on-view set, hydrate every record (resumable
   * via a cache under data/raw/{id}/), and write snapshots into snapDir.
   * Returns the run stats it also wrote to objects-meta.json.
   */
  fullFetch(opts: FullFetchOptions): Promise<Record<string, unknown>>;
  /**
   * Incremental refresh of snapDir/objects.json.gz in place: hydrate only
   * records new/changed since `since` (ISO date), tombstone off-view rows.
   * Returns the number of records hydrated.
   */
  delta(snapDir: string, since: string): Promise<number>;
}
