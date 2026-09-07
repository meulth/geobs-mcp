import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { KvCatalog } from "../src/catalog";

// Public metadata only. This command prepares a reviewed snapshot; it does not
// write remote KV or expose an HTTP refresh endpoint.
const destination = resolve(".wrangler/ogc-catalog.json");
await mkdir(resolve(".wrangler"), { recursive: true });
const catalog = new KvCatalog({
  async get() {
    try { return await readFile(destination, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  async put(_key, value) { await writeFile(destination, value, "utf8"); }
});
const snapshot = await catalog.refresh();
console.log(JSON.stringify({ file: destination, fetchedAt: snapshot.fetchedAt,
  collectionCount: snapshot.collectionCount, contentHash: snapshot.contentHash }));
