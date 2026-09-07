import { describe, expect, it } from "vitest";
import { StacClient } from "../../src/clients/stac";
import { SearchClient } from "../../src/clients/search";
import { OgcFeaturesClient } from "../../src/clients/ogcFeatures";
import { PropertyInfoClient } from "../../src/clients/propertyInfo";
import { searchFeatureCollections } from "../../src/tools/searchFeatureCollections";
import { createCatalogSnapshot } from "../../src/catalog";
import { getDataset } from "../../src/tools/getDataset";
import { searchLocation } from "../../src/tools/searchLocation";
import { queryFeatures } from "../../src/tools/queryFeatures";
import { getPropertyInfo } from "../../src/tools/getPropertyInfo";

const apiKey = process.env.GEOBS_API_KEY;

describe("GeoBS live APIs", () => {
  const stac = new StacClient();
  const ogc = new OgcFeaturesClient();

  it("discovers datasets about Strassen and loads Strassennamen metadata", async () => {
    // Simulate a populated cache using live metadata; the search itself does no HTTP.
    const snapshot = await createCatalogSnapshot(await ogc.listCollections());
    const discovery = await searchFeatureCollections({ get: async () => snapshot }, { query: "Strassennamen", limit: 10 });
    const id = discovery.collections.find(layer => layer.stacDatasetId === "STNA")?.stacDatasetId;
    expect(id).toBe("STNA");

    const dataset = await getDataset(stac, ogc, { id });
    expect(dataset.title).toMatch(/Strassennamen/i);
    expect(dataset.items[0]?.assets.some((asset) => asset.key === "geojson")).toBe(true);
    expect(dataset.ogcFeaturesDiscovery.collections.length).toBeGreaterThan(0);
  });

  it("queries OGC features around Dufourstrasse 40 in EPSG:2056", async () => {
    const result = await queryFeatures(ogc, {
      collectionId: "ch.bs.strassennamen_stna",
      point: { x: 2611776.302, y: 1266865.109, epsg: 2056, radius: 50 },
      limit: 5,
      includeGeometry: false
    });
    expect(result.features.length).toBeGreaterThan(0);
    expect(
      result.features.some((feature) =>
        JSON.stringify(feature.properties).toLocaleLowerCase("de-CH").includes("dufourstrasse")
      )
    ).toBe(true);
  });

  it.skipIf(!apiKey)(
    "resolves Dufourstrasse 40 and retrieves property/building information",
    async () => {
      const search = new SearchClient(apiKey);
      const propertyInfo = new PropertyInfoClient(apiKey);
      const location = await searchLocation(search, {
        query: "Dufourstrasse 40",
        limit: 5,
        epsg: 2056,
        outputFormat: "geom"
      });
      const coordinate = location.results[0]?.coordinate;
      expect(coordinate).toBeDefined();

      const result = await getPropertyInfo(propertyInfo, ogc, {
        point: { x: coordinate![0], y: coordinate![1], epsg: 2056 },
        withGeometry: false
      });
      expect(result.realEstates).toBeInstanceOf(Array);
      expect(JSON.stringify(result.realEstates)).toContain("Dufourstrasse");
    }
  );
});
