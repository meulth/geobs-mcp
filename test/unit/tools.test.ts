import { describe, expect, it } from "vitest";
import type { StacClient } from "../../src/clients/stac";
import type { OgcFeaturesClient } from "../../src/clients/ogcFeatures";
import { searchDatasets } from "../../src/tools/searchDatasets";
import { queryFeatures } from "../../src/tools/queryFeatures";
import { enforceFeatureOutputLimit } from "../../src/tools/output";

describe("tool validation and mapping", () => {
  it("ranks real STAC-shaped metadata without a hardcoded dataset list", async () => {
    const client = {
      listCollections: async () => [
        { id: "TREE", title: "Bäume", description: "Baumkataster", links: [] },
        {
          id: "STNA",
          title: "Strassennamen",
          description: "Strassen und Plätze",
          keywords: ["Strasse"],
          links: []
        }
      ]
    } as unknown as StacClient;
    const result = await searchDatasets(client, { query: "Strassen", limit: 5 });
    expect(result.datasets[0]?.id).toBe("STNA");
  });

  it("rejects ambiguous point plus bbox input before upstream calls", async () => {
    const client = { queryFeatures: async () => ({}) } as unknown as OgcFeaturesClient;
    await expect(
      queryFeatures(client, {
        collectionId: "ch.bs.test",
        bbox: [0, 0, 1, 1],
        point: { x: 0, y: 0, epsg: 2056 },
        limit: 1
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("omits geometry before exceeding the MCP output budget", () => {
    const output = enforceFeatureOutputLimit({
      features: [
        {
          id: "1",
          geometry: { type: "LineString", coordinates: ["x".repeat(260_000)] }
        }
      ]
    });
    expect(output.geometryOmitted).toBe(true);
    expect(output.features[0]).not.toHaveProperty("geometry");
  });
});
