import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerReadOnlyTool } from "../mcp/register";
import { LIMITS } from "../config";
import {
  bboxSchema, collectionIdSchema, epsgSchema, outputPropertiesSchema,
  pointSchema, propertyFiltersSchema
} from "../schemas";
import type { OgcFeaturesClient } from "../clients/ogcFeatures";
import { GeoBsError } from "../errors";
import { compactText, enforceFeatureOutputLimit } from "./output";

const queryFeaturesShape = {
  collectionId: collectionIdSchema.describe("Exact OGC collection ID returned by get_dataset."),
  bbox: bboxSchema.optional(),
  point: pointSchema.extend({ radius: z.number().finite().min(0).optional() }).optional().describe("Point query; radius is expressed in units of the point CRS."),
  bboxEpsg: epsgSchema.default(2056),
  outputEpsg: epsgSchema.optional(),
  limit: z.number().int().min(1).max(LIMITS.maxFeatures).default(10),
  properties: outputPropertiesSchema.optional(),
  filters: propertyFiltersSchema.optional(),
  includeGeometry: z.boolean().default(true)
};

const queryFeaturesInput = z.object(queryFeaturesShape);

const queryFeaturesOutputShape = {
  collection: z.object({ id: z.string() }).catchall(z.json()),
  crs: z.string(),
  numberReturned: z.number().int(),
  features: z.array(z.object({ id: z.union([z.string(), z.number()]).optional() }).catchall(z.json()))
};

export async function queryFeatures(
  client: OgcFeaturesClient,
  input: unknown
) {
  const parsed = queryFeaturesInput.parse(input);
  if (parsed.bbox && parsed.point) {
    throw new GeoBsError("INVALID_INPUT", "Provide either bbox or point, not both.");
  }

  let bbox = parsed.bbox;
  let bboxEpsg = parsed.bboxEpsg;
  if (parsed.point) {
    const radius = parsed.point.radius ?? 0;
    const geographic = parsed.point.epsg === 4326 || parsed.point.epsg === 4258;
    const maximum = geographic ? 0.25 : 10_000;
    if (radius > maximum) {
      throw new GeoBsError(
        "INVALID_INPUT",
        `Point radius exceeds the ${maximum} coordinate-unit safety limit for EPSG:${parsed.point.epsg}.`
      );
    }
    bbox = [
      parsed.point.x - radius,
      parsed.point.y - radius,
      parsed.point.x + radius,
      parsed.point.y + radius
    ];
    bboxEpsg = parsed.point.epsg;
  }

  const result = await client.queryFeatures(parsed.collectionId, {
    bbox,
    bboxEpsg,
    outputEpsg: parsed.outputEpsg ?? bboxEpsg,
    limit: parsed.limit,
    properties: parsed.properties,
    filters: parsed.filters
  });

  const features = result.featureCollection.features ?? [];
  const mapped = {
    collection: {
      id: result.collection.id,
      title: result.collection.title,
      description: compactText(result.collection.description),
      advertisedCrs: result.collection.crs ?? []
    },
    crs: `EPSG:${result.outputEpsg}`,
    numberMatched: result.featureCollection.numberMatched,
    numberReturned: features.length,
    features: features.map((feature) => ({
      id: feature.id,
      properties: feature.properties ?? {},
      bbox: feature.bbox,
      ...(parsed.includeGeometry ? { geometry: feature.geometry } : {})
    }))
  };
  return enforceFeatureOutputLimit(mapped, summarize);
}

function summarize(output: { numberReturned: number; collection: { id: string } }): string {
  return `Returned ${output.numberReturned} bounded feature(s) from ${output.collection.id}.`;
}

export function registerQueryFeatures(server: McpServer, client: OgcFeaturesClient) {
  registerReadOnlyTool(server, {
    name: "query_features",
    title: "Query GeoBS features",
    description:
      "Run a bounded read-only OGC API Features query against an exact collection ID returned by get_dataset. Supports bbox or point/radius, advertised CRS, selected output properties and at most five exact property filters. Arbitrary URLs and query strings are not accepted.",
    inputSchema: queryFeaturesShape,
    outputSchema: queryFeaturesOutputShape,
    execute: (input) => queryFeatures(client, input),
    summarize
  });
}
