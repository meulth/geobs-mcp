import { describe, expect, it, vi } from "vitest";
import { OgcFeaturesClient } from "../../src/clients/ogcFeatures";
import { CRS, LIMITS } from "../../src/config";
import { queryFeatures } from "../../src/tools/queryFeatures";
import { fitsToolOutput } from "../../src/mcp/results";

const center = { x: 2611696.334, y: 1267078.092, epsg: 2056 };
const collectionId = "ch.bs.example_test.points";
function point(id: number | string, x: number, y: number) {
  return { type: "Feature", id, properties: {}, geometry: { type: "Point", coordinates: [center.x + x, center.y + y] } };
}
function setup(features: unknown[], metadata: Record<string, unknown> = {}, crs?: string) {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ id: collectionId, crs: [CRS[2056], CRS[4326]] }))
    .mockResolvedValueOnce(Response.json({ features, numberMatched: features.length, numberReturned: features.length, ...metadata },
      { headers: crs ? { "content-crs": crs } : {} }));
  return { client: new OgcFeaturesClient(fetcher), fetcher };
}
function input(extra: Record<string, unknown> = {}) {
  return { collectionId, spatialMode: "circle", point: { ...center, radius: 300 }, ...extra };
}

describe("bounded circle answers", () => {
  it("includes the unrounded circle boundary, excludes all box corners, and sorts before applying the result limit", async () => {
    // Integer center avoids cancellation noise in the exact 3-4-5 boundary case.
    const origin = { x: 2600000, y: 1200000, epsg: 2056 };
    const offsets = [[300, 300], [-300, 300], [300, -300], [-300, -300],
      [180, 240.001], [180, 240], [300, 0], [0, 0], [1, 0]];
    const features = offsets.map(([x, y], id) => ({ ...point(id, 0, 0), geometry: { type: "Point", coordinates: [origin.x + x!, origin.y + y!] } }));
    const { client, fetcher } = setup(features);
    const result = await queryFeatures(client, input({ point: { ...origin, radius: 300 }, limit: 3 }));
    expect(result.features.map(f => f.id)).toEqual([7, 8, 5]);
    expect(result.features.map(f => f.distanceMeters)).toEqual([0, 1, 300]);
    expect(result.spatial.matchesInCandidates).toBe(4);
    expect(result.coverage).toMatchObject({ complete: false, candidatesComplete: true, reasons: ["result_limit"] });
    expect(new URL(String(fetcher.mock.calls[1]![0])).searchParams.get("limit")).toBe(String(LIMITS.maxFeatures));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("reproduces the journey coordinates with correct distances from the echoed center", async () => {
    const features = [
      { ...point(540, 0, 0), geometry: { type: "Point", coordinates: [2611709.536, 1267099.015] } },
      { ...point(536, 0, 0), geometry: { type: "Point", coordinates: [2611568.845, 1267034.493] } },
      { ...point(541, 0, 0), geometry: { type: "Point", coordinates: [2611830.789, 1266784.253] } }
    ];
    const { client } = setup(features, {}, `<${CRS[2056]}>`);
    const result = await queryFeatures(client, input({ includeGeometry: false }));
    expect(result.features.map(f => f.id)).toEqual([540, 536]);
    expect(result.features[0]!.distanceMeters).toBeCloseTo(24.73994, 4);
    expect(result.features[1]!.distanceMeters).toBeCloseTo(134.73796, 4);
    expect(result.features[0]).not.toHaveProperty("geometry");
    expect(result.spatial.center).toEqual({ ...center, radius: 300 });
    expect(result.coverage.complete).toBe(true);
    expect(result.source.dataUpdatedAt).toBeNull();
    expect(result.spatial.crsEvidence).toBe("response_header");
  });

  it.each([
    [{ numberMatched: 63 }, "upstream_limit"],
    [{ numberMatched: null }, "unknown_total"],
    [{ numberMatched: 24 }, "inconsistent_counts"],
    [{ numberReturned: 24 }, "inconsistent_counts"],
    [{ links: [{ rel: "next", href: "https://example.com/untrusted" }] }, "next_page"]
  ])("never claims a complete/nearest result for incomplete metadata %j", async (metadata, reason) => {
    // An unseen page could contain a closer point than every loaded candidate.
    const { client, fetcher } = setup(Array.from({ length: 25 }, (_, i) => point(i, 100 + i, 0)), metadata);
    const result = await queryFeatures(client, input({ limit: 25 }));
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.reasons).toContain(reason);
    expect(fetcher).toHaveBeenCalledTimes(2); // Never follows arbitrary next URLs.
  });

  it("recognizes exactly 25 of 25 as complete and preserves raw overflow evidence", async () => {
    const full = setup(Array.from({ length: 25 }, (_, i) => point(i, i, 0)));
    expect((await queryFeatures(full.client, input({ limit: 25 }))).coverage.complete).toBe(true);
    const overflow = setup(Array.from({ length: 26 }, (_, i) => point(i, i, 0)));
    const result = await queryFeatures(overflow.client, input({ limit: 25 }));
    expect(result.coverage.reasons).toContain("candidate_limit");
    expect(result.coverage.complete).toBe(false);
  });

  it("does not call an empty partial page proof of no nearby objects", async () => {
    const { client } = setup([], { links: [{ rel: "next", href: "unused" }] });
    const result = await queryFeatures(client, input());
    expect(result.features).toEqual([]);
    expect(result.coverage.complete).toBe(false);
  });

  it.each([null, { type: "Polygon", coordinates: [] }, { type: "MultiPoint", coordinates: [[1, 2]] },
    { type: "Point", coordinates: [1] }, { type: "Point", coordinates: ["1", 2] }])("rejects unsupported geometry %j", async geometry => {
    const { client } = setup([{ ...point(1, 0, 0), geometry }]);
    await expect(queryFeatures(client, input())).rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
  });

  it("handles zero radius and horizontal Point Z without rounding the filter", async () => {
    const zero = { ...point("zero", 0, 0), geometry: { type: "Point", coordinates: [center.x, center.y, 100] } };
    const { client } = setup([point("near", 0.001, 0), zero]);
    const result = await queryFeatures(client, input({ point: { ...center, radius: 0 } }));
    expect(result.features.map(f => f.id)).toEqual(["zero"]);
    expect(result.features[0]!.distanceMeters).toBe(0);
  });

  it.each([{ point: { ...center, epsg: 4326, radius: 1 } }, { outputEpsg: 4326 },
    { point: center }, { point: { ...center, radius: 1001 } }])("rejects unsupported radius input before any calls %j", async extra => {
    const { client, fetcher } = setup([]);
    await expect(queryFeatures(client, input(extra))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails on contradictory CRS and explicitly labels a missing response header", async () => {
    const bad = setup([point(1, 0, 0)], {}, `<${CRS[4326]}>`);
    await expect(queryFeatures(bad.client, input())).rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
    const missing = setup([point(1, 0, 0)]);
    const result = await queryFeatures(missing.client, input());
    expect(result.warnings.join(" ")).toContain("CRS_HEADER_MISSING");
  });

  it("marks byte-trimmed results incomplete without losing calculated distances", async () => {
    const { client } = setup([1, 2, 3].map(id => ({ ...point(id, id, 0), properties: { text: "x".repeat(50000) } })));
    const result = await queryFeatures(client, input());
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.reasons).toContain("output_byte_limit");
    expect(result.numberReturned).toBe(result.features.length);
    expect(result.features[0]!.distanceMeters).toBe(1);
    expect(fitsToolOutput(result)).toBe(true);
  });

  it("labels ordinary polygon queries as boxes, with no fabricated distances", async () => {
    const { client } = setup([{ ...point(1, 0, 0), geometry: { type: "Polygon", coordinates: [] } }]);
    const result = await queryFeatures(client, { collectionId, point: { ...center, radius: 300 } });
    expect(result.spatial.mode).toBe("bbox");
    expect(result.features[0]).not.toHaveProperty("distanceMeters");
    expect(result.numberMatchedScope).toBe("upstream_bbox_candidates");
  });

  it("scopes completeness to property filters instead of implying completeness of their union", async () => {
    const { client } = setup([point(1, 0, 0)]);
    const filters = [{ property: "Typ", value: "Bus" }];
    const result = await queryFeatures(client, input({ filters }));
    expect(result.coverage.complete).toBe(true);
    expect(result.coverage.scope).toBe("selected_geometry_AND_property_filters_only");
    expect(result.query.filters).toEqual(filters);
    expect(result.warnings.join(" ")).toContain("do not prove complete unfiltered coverage");
  });
});
