import { describe, expect, it, vi } from "vitest";
import { OgcFeaturesClient } from "../../src/clients/ogcFeatures";
import { findCollectionsForDataset, findParcelCollection } from "../../src/discovery";

const collection = {
  id: "ch.bs.strassennamen_stna",
  title: "Strassennamen",
  crs: [
    "http://www.opengis.net/def/crs/EPSG/0/2056",
    "http://www.opengis.net/def/crs/EPSG/0/4326"
  ],
  links: []
};

describe("OgcFeaturesClient", () => {
  it("builds a bounded spatial query with controlled exact filters", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(collection))
      .mockResolvedValueOnce(
        Response.json({
          type: "FeatureCollection",
          numberMatched: 1,
          features: [{ type: "Feature", id: "1", properties: { name: "Dufour" } }]
        })
      );
    const result = await new OgcFeaturesClient(fetcher).queryFeatures(collection.id, {
      bbox: [2611776, 1266865, 2611776, 1266865],
      bboxEpsg: 2056,
      outputEpsg: 2056,
      limit: 999,
      properties: ["name"],
      filters: [{ property: "name", value: "Dufour" }]
    });
    const url = new URL(String(fetcher.mock.calls[1]![0]));
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("bbox-crs")).toContain("2056");
    expect(url.searchParams.get("name")).toBe("Dufour");
    expect(result.featureCollection.features).toHaveLength(1);
  });

  it("rejects reserved property filters", async () => {
    const fetcher = vi.fn(async () => Response.json(collection));
    await expect(
      new OgcFeaturesClient(fetcher).queryFeatures(collection.id, {
        filters: [{ property: "limit", value: 5000 }]
      })
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("discovers STAC/WFS matches by delimited dataset code", () => {
    const collections = [
      collection,
      { id: "ch.bs.other_stnax", title: "Not a match" },
      {
        id: "ch.bs.av_parzellen_rechtliche_abgrenzungen_avpz.liegenschaft",
        title: "Amtliche Vermessung Parzellen und andere rechtliche Abgrenzungen - Liegenschaft",
        description: "EGRID der Parzellen"
      }
    ];
    expect(findCollectionsForDataset("STNA", collections)).toEqual([collection]);
    expect(findParcelCollection(collections)?.id).toContain(".liegenschaft");
  });
});
