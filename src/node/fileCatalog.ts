import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createCatalogSnapshot, KvCatalog, parseCatalogSnapshot, type CatalogStore } from "../catalog";
import { LIMITS } from "../config";
import { GeoBsError } from "../errors";
import type { FetchLike } from "../http";

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

// The active file is never modified in place. Readers keep a whole old or new
// inode; both the temporary file and rename live in the destination directory.
export class FileCatalogStore implements CatalogStore {
  readonly path: string;
  // Reading, parsing and re-hashing up to 12 MB on every tool call and every
  // readiness probe is an unauthenticated CPU/memory amplifier. A verified file
  // is reused while its identity is unchanged. Replacements always use rename
  // (new inode), so a refresh is picked up on the next read.
  private verified?: { identity: string; raw: string };
  constructor(path: string, private readonly now = Date.now) { this.path = resolve(path); }

  async get(): Promise<string | null> {
    let file;
    try { file = await open(this.path, "r"); }
    catch (error) { if (missing(error)) return null; throw error; }
    try {
      const info = await file.stat();
      const identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if (this.verified?.identity === identity) return this.verified.raw;
      this.verified = undefined;
      if (info.size > LIMITS.maxWfsCollectionsBytes) throw new GeoBsError(
        "RESPONSE_TOO_LARGE", "The cached OGC catalog exceeds its size limit.");
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        length += chunk.length;
        if (length > LIMITS.maxWfsCollectionsBytes) throw new GeoBsError(
          "RESPONSE_TOO_LARGE", "The cached OGC catalog exceeds its size limit.");
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const snapshot = parseCatalogSnapshot(raw, this.now());
      const verified = await createCatalogSnapshot(snapshot.collections, Date.parse(snapshot.fetchedAt));
      if (verified.contentHash !== snapshot.contentHash) throw new GeoBsError(
        "INVALID_UPSTREAM_RESPONSE", "The cached OGC catalog checksum is invalid.");
      // Returning the same string instance lets KvCatalog reuse its parsed snapshot.
      this.verified = { identity, raw };
      return raw;
    } finally { await file.close(); }
  }

  async put(_key: string, value: string): Promise<void> {
    if (Buffer.byteLength(value) > LIMITS.maxWfsCollectionsBytes) throw new GeoBsError(
      "RESPONSE_TOO_LARGE", "The cached OGC catalog exceeds its size limit.");
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = resolve(dirname(this.path), `.${basename(this.path)}.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(value, "utf8"); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.path);
      this.verified = undefined;
      if (process.platform !== "win32") {
        const directory = await open(dirname(this.path), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally {
      await unlink(temporary).catch(error => { if (!missing(error)) throw error; });
    }
  }
}

export class FileCatalog extends KvCatalog {
  private readonly fileStore: FileCatalogStore;
  constructor(path: string, now = Date.now) {
    const store = new FileCatalogStore(path, now);
    super(store, now);
    this.fileStore = store;
  }

  // Pod initialisation reuses an admissible snapshot. Missing/expired catalogs
  // use the same bounded, locked refresh; corruption/IO errors remain failures.
  async ensure(fetcher: FetchLike = fetch) {
    try { return await this.get(); }
    catch (error) {
      if (!(error instanceof GeoBsError) || error.code !== "UPSTREAM_UNAVAILABLE") throw error;
    }
    return this.refresh(fetcher);
  }

  override async refresh(fetcher: FetchLike = fetch) {
    await mkdir(dirname(this.fileStore.path), { recursive: true });
    const lockPath = `${this.fileStore.path}.refresh.lock`;
    const token = await acquireLock(lockPath);
    try { return await super.refresh(fetcher); }
    finally { await releaseLock(lockPath, token); }
  }
}

async function acquireLock(lockPath: string): Promise<string> {
  const token = randomUUID();
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Age cannot prove that the owner is dead. Stat followed by rename/unlink
    // can also remove a replacement lock acquired by a concurrent refresher.
    // Recovery is administrative, with all writers stopped, including on RWX.
    throw new GeoBsError("UPSTREAM_UNAVAILABLE",
      "A catalog refresh lock already exists; stop all refreshers and verify the owner has exited before removing a leftover lock.", true);
  }
  try { await lock.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }), "utf8"); }
  finally { await lock.close(); }
  return token;
}

// Cooperative refreshers never replace an existing lock. The token check also
// leaves an unexpected foreign lock untouched; it is not a filesystem CAS.
async function releaseLock(lockPath: string, token: string): Promise<void> {
  let content;
  try { content = await readFile(lockPath, "utf8"); }
  catch (error) { if (missing(error)) return; throw error; }
  let owner: unknown;
  try { owner = (JSON.parse(content) as { token?: unknown }).token; } catch { return; }
  if (owner === token) await unlink(lockPath).catch(error => { if (!missing(error)) throw error; });
}
