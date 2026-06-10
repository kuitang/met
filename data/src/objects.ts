/** Objects pipeline: Met API isOnView search → hydrate all IDs (~40 req/s) → lean object rows (id, title, artist, classification, gallery, site, rotation, image, metadataDate); incremental via metadataDate; same code runs as repo script and the server's nightly job. */
function main(): void {
  throw new Error("not implemented");
}

main();
