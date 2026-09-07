import { describe, expect, it, vi } from "vitest";
import { catalogStatus, CATALOG_KEY, CATALOG_URL, createCatalogSnapshot, isCatalogRefreshTime, KvCatalog } from "../../src/catalog";
import worker from "../../src/index";
import { searchFeatureCollections } from "../../src/tools/searchFeatureCollections";

const NOW = Date.parse("2026-09-09T01:00:00Z");
const DAY = 86_400_000;
const rows = [
  { id: "ch.bs.avpz.liegenschaft", title: "Liegenschaften", description: "Parzellen und Grundstücke", extent: { spatial: {} }, links: [{ rel: "items", href: `${CATALOG_URL}/items` }] },
  { id: "ch.bs.avpz.grenzpunkt", title: "Grenzpunkte", description: "Grenzen der Parzellen" },
  { id: "ch.bs.baum", title: "Bäume", description: "Baumkataster der Stadt" }
];
function memoryStore(raw: string | null = null) {
  return {
    get: vi.fn(async () => raw),
    put: vi.fn(async (_key: string, value: string) => { raw = value; })
  };
}
const response = (collections: unknown, links: unknown[] = []) =>
  vi.fn(async () => Response.json({ collections, links }));

describe("weekly OGC catalog", () => {
  it("keeps full metadata, stable content hashes and a new verification time", async () => {
    const first = await createCatalogSnapshot(rows, NOW - 7 * DAY);
    const store = memoryStore(JSON.stringify(first));
    const next = await new KvCatalog(store, () => NOW).refresh(response([...rows].reverse()));
    expect(next.contentHash).toBe(first.contentHash);
    expect(next.fetchedAt).toBe(new Date(NOW).toISOString());
    expect(next.collections.find(row => row.id === rows[0]!.id)).toEqual(rows[0]);
    // No expiration: a failed refresh must not delete the last good catalog.
    expect(store.put).toHaveBeenCalledExactlyOnceWith(CATALOG_KEY, JSON.stringify(next));
  });

  it.each([8, 14])("serves %i-day-old data marked stale without fetching upstream", async days => {
    const snapshot = await createCatalogSnapshot(rows, NOW - days * DAY);
    const store = memoryStore(JSON.stringify(snapshot));
    const result = await searchFeatureCollections(new KvCatalog(store, () => NOW), { query: "avpz" });
    expect(result.catalogFetchedAt).toBe(snapshot.fetchedAt);
    expect(catalogStatus(snapshot, NOW).catalogStale).toBe(true);
    expect(store.put).not.toHaveBeenCalled();
    expect(result.collections).toHaveLength(2);
  });

  it("rejects data older than 14 days, but can refresh it", async () => {
    const old = await createCatalogSnapshot(rows, NOW - 14 * DAY - 1);
    const store = memoryStore(JSON.stringify(old));
    const catalog = new KvCatalog(store, () => NOW);
    await expect(catalog.get()).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    await catalog.refresh(response(rows));
    await expect(catalog.get()).resolves.toMatchObject({ fetchedAt: new Date(NOW).toISOString() });
  });

  it("reports missing caches without public upstream fallback", async () => {
    await expect(new KvCatalog(undefined).get()).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    await expect(new KvCatalog(memoryStore()).get()).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });

  it.each(["{", "null", '{"schemaVersion":2}'])("rejects malformed cache %s", async raw => {
    await expect(new KvCatalog(memoryStore(raw)).get()).rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
  });

  it("rejects future timestamps and mismatching counts", async () => {
    const snapshot = await createCatalogSnapshot(rows, NOW + 61_000);
    await expect(new KvCatalog(memoryStore(JSON.stringify(snapshot)), () => NOW).get())
      .rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
    snapshot.fetchedAt = new Date(NOW).toISOString();
    snapshot.collectionCount = 999;
    await expect(new KvCatalog(memoryStore(JSON.stringify(snapshot)), () => NOW).get())
      .rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
  });

  it.each([
    { collections: [] }, { collections: [rows[0], rows[0]] },
    { collections: [{ id: "../invalid" }] }, { collections: [rows[0]] },
    { collections: rows, links: [{ rel: "next" }] }
  ])("preserves last good snapshot on invalid/truncated replacements: %j", async body => {
    const old = JSON.stringify(await createCatalogSnapshot(rows, NOW - 7 * DAY));
    const store = memoryStore(old);
    await expect(new KvCatalog(store, () => NOW).refresh(async () => Response.json(body)))
      .rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
    expect(store.put).not.toHaveBeenCalled();
    expect(await store.get()).toBe(old);
  });

  it("preserves last good snapshot when upstream is unavailable", async () => {
    const store = memoryStore(JSON.stringify(await createCatalogSnapshot(rows, NOW)));
    await expect(new KvCatalog(store, () => NOW).refresh(async () => new Response("", { status: 503 })))
      .rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    expect(store.put).not.toHaveBeenCalled();
  });

  it.each([
    ["2026-09-09T01:00:00Z", true], ["2026-09-09T02:00:00Z", false],
    ["2026-12-09T01:00:00Z", false], ["2026-12-09T02:00:00Z", true],
    ["2026-09-08T01:00:00Z", false], ["2026-09-09T01:01:00Z", false],
    ["2026-03-25T02:00:00Z", true], ["2026-04-01T01:00:00Z", true],
    ["2026-10-21T01:00:00Z", true], ["2026-10-28T02:00:00Z", true]
  ])("gates %s to Wednesday 03:00 Europe/Zurich: %s", (timestamp, expected) => {
    expect(isCatalogRefreshTime(Date.parse(timestamp))).toBe(expected);
  });

  it("does not touch storage on the unused UTC cron slot", async () => {
    await expect(worker.scheduled({ scheduledTime: Date.parse("2026-09-09T02:00:00Z") } as ScheduledController, {})).resolves.toBeUndefined();
  });

  it("refreshes through the scheduled Worker handler at the selected slot", async () => {
    const store = memoryStore();
    const fetcher = response(rows);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", fetcher);
    try {
      await worker.scheduled({ scheduledTime: NOW } as ScheduledController, { OGC_CATALOG: store as unknown as KVNamespace });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(store.put).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "catalog_refresh", outcome: "success", collection_count: 3 }));
    } finally { vi.unstubAllGlobals(); log.mockRestore(); }
  });
});

describe("direct OGC collection search", () => {
  const reader = async (collections: unknown = rows) => {
    const snapshot = await createCatalogSnapshot(collections);
    return { get: vi.fn(async () => snapshot) };
  };

  it("keeps layers separate and provides field-specific reasons", async () => {
    const result = await searchFeatureCollections(await reader(), { query: "AVPZ Parzellen" });
    expect(result.totalMatches).toBe(2);
    expect(result.collections.map(row => row.id)).toContain(rows[0]!.id);
    expect(result.collections[0]!.matchReasons).toContainEqual({ field: "id", match: "terms", terms: ["avpz"] });
    expect(result.collections[0]!.matchReasons).toContainEqual({ field: "description", match: "terms", terms: ["parzellen"] });
    expect(result.catalogStale).toBe(false);
  });

  it("returns a literal ID first and an exact title before descriptive matches", async () => {
    const catalog = await reader([...rows, { id: "ch.bs.other", title: rows[0]!.id },
      { id: "ch.bs.first", description: "Bäume" }]);
    const idResult = await searchFeatureCollections(catalog, { query: rows[0]!.id });
    expect(idResult.collections[0]!.id).toBe(rows[0]!.id);
    expect(idResult.collections[0]!.matchReasons[0]!.match).toBe("exact");
    const titleResult = await searchFeatureCollections(catalog, { query: "Baeume" });
    expect(titleResult.collections[0]!.id).toBe("ch.bs.baum");
  });

  it("requires all terms and returns an explicit empty result", async () => {
    const result = await searchFeatureCollections(await reader(), { query: "Bäume Parzellen" });
    expect(result).toMatchObject({ totalMatches: 0, resultCount: 0, collections: [], truncated: false, searchedCollectionCount: 3 });
  });

  it("bounds a product with 21 layers, preserves IDs and exposes truncation", async () => {
    const catalog = await reader(Array.from({ length: 21 }, (_, i) => ({ id: `ch.bs.avpz.layer_${i.toString().padStart(2, "0")}`, title: "x".repeat(1000), description: "y".repeat(2000) })));
    const result = await searchFeatureCollections(catalog, { query: "avpz", limit: 20 });
    expect(result).toMatchObject({ totalMatches: 21, resultCount: 20, truncated: true });
    expect(result.collections[0]!.id).toBe("ch.bs.avpz.layer_00");
    expect(result.collections[0]!.title!.length).toBeLessThanOrEqual(300);
    expect(result.collections[0]!.description!.length).toBeLessThanOrEqual(600);
    expect((await searchFeatureCollections(catalog, { query: "avpz" })).resultCount).toBe(8);
  });

  it.each([{ query: "--" }, { query: "a" }, { query: "avpz", limit: 21 }, { query: Array.from({ length: 21 }, (_, i) => `a${i}`).join(" ") }])("rejects invalid searches before reading KV: %j", async input => {
    const catalog = await reader();
    await expect(searchFeatureCollections(catalog, input)).rejects.toBeDefined();
    expect(catalog.get).not.toHaveBeenCalled();
  });
});
