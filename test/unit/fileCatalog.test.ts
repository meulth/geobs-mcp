import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileCatalog, FileCatalogStore } from "../../src/node/fileCatalog";
import { createCatalogSnapshot } from "../../src/catalog";
import { LIMITS } from "../../src/config";

const NOW = Date.parse("2026-10-31T10:00:00Z");
const DAY = 86_400_000;
const rows = [{ id: "ch.bs.strassennamen_stna", title: "Strassennamen" }];
const directories: string[] = [];
async function fixture(age = 0) {
  const dir = await mkdtemp(join(tmpdir(), "geobs-file-test-"));
  directories.push(dir);
  const path = join(dir, "ogc-catalog.v1.json");
  const snapshot = await createCatalogSnapshot(rows, NOW - age);
  await writeFile(path, JSON.stringify(snapshot));
  return { dir, path, snapshot, catalog: new FileCatalog(path, () => NOW) };
}
afterEach(async () => {
  for (const dir of directories.splice(0)) {
    if (!dir.startsWith(join(tmpdir(), "geobs-file-test-"))) throw new Error("Unexpected cleanup path");
    await rm(dir, { recursive: true, force: true });
  }
});

describe("local atomic catalog", () => {
  it("reads a valid snapshot after a restart and preserves its original date", async () => {
    const { path, snapshot } = await fixture();
    expect(await new FileCatalog(path, () => NOW).get()).toEqual(snapshot);
  });

  it.each([8 * DAY, 14 * DAY])("serves a stale but admissible snapshot (%i ms)", async age => {
    const { catalog, snapshot } = await fixture(age);
    expect(await catalog.get()).toEqual(snapshot);
  });

  it("rejects an expired file but refreshes it outside the calendar minute", async () => {
    const { catalog } = await fixture(14 * DAY + 1);
    await expect(catalog.get()).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    const fetcher = vi.fn(async () => Response.json({ collections: rows }));
    await catalog.refresh(fetcher);
    expect((await catalog.get()).fetchedAt).toBe(new Date(NOW).toISOString());
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("initialises an absent file without a public request fallback", async () => {
    const { path } = await fixture();
    await rm(path);
    const catalog = new FileCatalog(path, () => NOW);
    await expect(catalog.get()).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    await catalog.refresh(async () => Response.json({ collections: rows }));
    expect((await catalog.get()).collectionCount).toBe(1);
  });

  it("rejects a modified collection even when its schema and hash syntax look valid", async () => {
    const { path, snapshot, catalog } = await fixture();
    snapshot.collections[0]!.title = "Tampered";
    await writeFile(path, JSON.stringify(snapshot));
    await expect(catalog.get()).rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
    const fetcher = vi.fn();
    await expect(catalog.refresh(fetcher)).rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the old whole file readable during refresh and excludes another writer", async () => {
    const { dir, path, snapshot, catalog } = await fixture();
    let deliver!: (response: Response) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const pending = catalog.refresh(async () => { started(); return new Promise(resolve => { deliver = resolve; }); });
    await ready;
    expect(await catalog.get()).toEqual(snapshot);
    await expect(new FileCatalog(path, () => NOW).refresh(vi.fn())).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    deliver(Response.json({ collections: [{ ...rows[0], title: "Updated" }] }));
    await pending;
    expect((await catalog.get()).collections[0]!.title).toBe("Updated");
    expect(await readdir(dir)).toEqual(["ogc-catalog.v1.json"]);
  });

  it.each([
    { collections: [] },
    { collections: rows, links: [{ rel: "next" }] },
    { collections: [...rows, { id: "ch.bs.second" }, { id: "ch.bs.third" }] }
  ])("preserves the valid file on invalid replacement: %j", async body => {
    const { path, dir, catalog } = await fixture();
    const previous = await readFile(path, "utf8");
    await expect(catalog.refresh(async () => Response.json(body))).rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
    expect(await readFile(path, "utf8")).toBe(previous);
    expect(await readdir(dir)).toHaveLength(1);
  });

  it("bounds file reads and replacement writes to 12,000,000 bytes", async () => {
    const { path, catalog } = await fixture();
    const previous = await readFile(path, "utf8");
    const oversized = " ".repeat(LIMITS.maxWfsCollectionsBytes + 1);
    await expect(new FileCatalogStore(path).put("unused", oversized)).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    expect(await readFile(path, "utf8")).toBe(previous);
    await writeFile(path, oversized);
    await expect(catalog.get()).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });
});
