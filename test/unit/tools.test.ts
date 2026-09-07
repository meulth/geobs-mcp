import { describe, expect, it } from "vitest";
import type { OgcFeaturesClient } from "../../src/clients/ogcFeatures";
import { queryFeatures } from "../../src/tools/queryFeatures";
import { enforceFeatureOutputLimit } from "../../src/tools/output";
import { fitsToolOutput, jsonByteLength, successResult } from "../../src/mcp/results";
import { LIMITS } from "../../src/config";

const summarize = (output: { numberReturned: number }) => `Returned ${output.numberReturned} features.`;

describe("tool validation and mapping", () => {
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
      numberReturned: 1,
      features: [
        {
          id: "1",
          geometry: { type: "LineString", coordinates: ["x".repeat(260_000)] }
        }
      ]
    }, summarize);
    expect(output.geometryOmitted).toBe(true);
    expect(output.features[0]).not.toHaveProperty("geometry");
  });

  it("enforces the output budget against the actual wire size, not just the structured value", () => {
    // A tool result is also serialized into a TextContent block (see
    // successResult), so the transmitted bytes are roughly double the bare
    // structured value. This payload stays under the limit by itself but
    // must still trigger truncation once that duplication is counted.
    const value = {
      numberReturned: 1,
      features: [
        {
          id: "1",
          geometry: { type: "LineString", coordinates: ["x".repeat(200_000)] }
        }
      ]
    };
    expect(JSON.stringify(value).length).toBeLessThan(250_000);
    expect(fitsToolOutput(value, summarize(value))).toBe(false);

    const output = enforceFeatureOutputLimit(value, summarize);
    expect(output.geometryOmitted).toBe(true);
    expect(output.features[0]).not.toHaveProperty("geometry");
  });

  it("updates counts and the summary when feature properties force truncation", async () => {
    const features = Array.from({ length: 3 }, (_, id) => ({
      id, properties: { text: "x".repeat(50_000) }
    }));
    const client = {
      queryFeatures: async () => ({
        collection: { id: "ch.bs.test" }, outputEpsg: 2056,
        featureCollection: { numberMatched: 3, features }
      })
    } as unknown as OgcFeaturesClient;
    const output = await queryFeatures(client, { collectionId: "ch.bs.test" });
    expect(output.outputTruncated).toBe(true);
    expect(output.features).toHaveLength(2);
    expect(output.numberReturned).toBe(2);
    expect(output.numberMatched).toBe(3);
    expect(features).toHaveLength(3);
    const result = successResult(summarize(output), output);
    expect(result.content[0]?.text).toBe("Returned 2 features.");
    expect(jsonByteLength(result)).toBeLessThanOrEqual(LIMITS.maxToolOutputBytes);
  });

  it("rejects a single feature whose properties exceed the budget", () => {
    expect(() => enforceFeatureOutputLimit({
      numberReturned: 1,
      features: [{ properties: { text: "x".repeat(130_000) } }]
    }, summarize)).toThrow(expect.objectContaining({ code: "RESPONSE_TOO_LARGE" }));
  });

  it("counts UTF-8 bytes and the summary in the final result budget", () => {
    const output = { value: "ä".repeat(60_000) };
    expect(fitsToolOutput(output)).toBe(true);
    expect(() => successResult("x".repeat(11_000), output))
      .toThrow(expect.objectContaining({ code: "RESPONSE_TOO_LARGE" }));
    expect(fitsToolOutput({ value: "ä".repeat(63_000) })).toBe(false);
  });
});
