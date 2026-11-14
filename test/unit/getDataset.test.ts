import { describe, expect, it, vi } from "vitest";
import { StacClient } from "../../src/clients/stac";
import { OgcFeaturesClient } from "../../src/clients/ogcFeatures";
import { createCatalogSnapshot, type CatalogReader } from "../../src/catalog";
import { getDataset } from "../../src/tools/getDataset";

describe("dataset provenance and bounded item coverage", () => {
  function clients(failItems = false, failCatalog = false) {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/items")) {
        if (failItems) return new Response(null, { status: 400 });
        return Response.json({ features: [{ id: "latest", properties: { datetime: "2026-01-01T00:00:00Z" } }],
          numberMatched: 1, numberReturned: 1 });
      }
      // No self link: source must still be deterministically available.
      return Response.json({ id: "STNA", title: "Strassennamen", links: [] });
    });
    const catalog: CatalogReader = { get: async () => {
      if (failCatalog) throw new Error("catalog unavailable");
      return createCatalogSnapshot([{ id: "ch.bs.strassennamen_stna" }]);
    } };
    return { stac: new StacClient(fetcher), ogc: new OgcFeaturesClient(fetcher, catalog) };
  }

  it("separates collection retrieval, item datetime and verified update dates", async () => {
    const { stac, ogc } = clients();
    const output = await getDataset(stac, ogc, { id: "STNA" });
    expect(output.source).toMatchObject({ url: "https://api.geo.bs.ch/stac/v1/collections/STNA", dataUpdatedAt: null });
    expect(Number.isFinite(Date.parse(output.source.retrievedAt))).toBe(true);
    expect(output.itemsSource.url).toBe("https://api.geo.bs.ch/stac/v1/collections/STNA/items?limit=10");
    expect(output.itemsCoverage).toMatchObject({ complete: true, numberReturned: 1, numberMatched: 1, requestedLimit: 10 });
    expect(output.items[0]?.datetime).toBe("2026-01-01T00:00:00Z");
    expect(output.guidance).toContain("dataset update date is unknown");
  });

  it("marks failed items as unavailable rather than a complete empty list", async () => {
    const { stac, ogc } = clients(true);
    const output = await getDataset(stac, ogc, { id: "STNA" });
    expect(output.items).toEqual([]);
    expect(output.itemsSource.retrievedAt).toBeNull();
    expect(output.itemsCoverage).toMatchObject({ complete: false, reasons: ["upstream_error"], numberReturned: 0, numberMatched: null });
    expect(output.warnings).toEqual([expect.objectContaining({ source: "stac_items" })]);
  });

  it("keeps independent item evidence when OGC discovery fails", async () => {
    const { stac, ogc } = clients(false, true);
    const output = await getDataset(stac, ogc, { id: "STNA" });
    expect(output.itemsCoverage.complete).toBe(true);
    expect(output.ogcFeaturesDiscovery.collections).toEqual([]);
    expect(output.warnings).toEqual([expect.objectContaining({ source: "wfs_discovery" })]);
  });
});
