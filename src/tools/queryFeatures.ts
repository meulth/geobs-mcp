import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerReadOnlyTool } from "../mcp/register";
import { API_URLS, CRS, LIMITS } from "../config";
import {
  bboxSchema, collectionIdSchema, epsgSchema, outputPropertiesSchema,
  pointSchema, propertyFiltersSchema
} from "../schemas";
import type { OgcFeaturesClient } from "../clients/ogcFeatures";
import { GeoBsError } from "../errors";
import { compactText, enforceFeatureOutputLimit } from "./output";
import { candidateCoverage, withinRadius } from "./spatial";

const queryFeaturesShape = {
  collectionId: collectionIdSchema.describe("Exact OGC collection ID returned by search_datasets_ogc or get_dataset_stac."),
  bbox: bboxSchema.optional(),
  point: pointSchema.extend({ radius: z.number().finite().min(0).optional() }).optional().describe("Copy exact coordinates from search_api_v2 or the previous query. For circle mode, radius is required in meters and EPSG must be 2056. An address point is not a verified entrance."),
  spatialMode: z.enum(["bbox", "circle"]).default("bbox").describe("Use circle for point-feature distances within an explicit radius of 0–1000 meters (EPSG:2056 only). Default bbox returns box candidates, never a circle answer. Polygons and lines require bbox."),
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
  features: z.array(z.object({ id: z.union([z.string(), z.number()]).optional(),
    distanceMeters: z.number().optional().describe("Server-calculated horizontal distance; only present for circle mode.") }).catchall(z.json())),
  coverage: z.object({ complete: z.boolean(), candidatesComplete: z.boolean(), reasons: z.array(z.string()) }).catchall(z.json()),
  spatial: z.object({ mode: z.enum(["bbox", "circle"]) }).catchall(z.json()),
  warnings: z.array(z.string())
};

export async function queryFeatures(
  client: OgcFeaturesClient,
  input: unknown
) {
  const parsed = queryFeaturesInput.parse(input);
  if (parsed.bbox && parsed.point) {
    throw new GeoBsError("INVALID_INPUT", "Provide either bbox or point, not both.");
  }
  const circle = parsed.spatialMode === "circle";
  if (circle && (!parsed.point || parsed.point.radius === undefined || parsed.point.epsg !== 2056 ||
    (parsed.outputEpsg !== undefined && parsed.outputEpsg !== 2056))) {
    throw new GeoBsError("INVALID_INPUT", "Circle mode requires point with an explicit radius in meters and input/output EPSG:2056.");
  }

  let bbox = parsed.bbox;
  let bboxEpsg = parsed.bboxEpsg;
  if (parsed.point) {
    const radius = parsed.point.radius ?? 0;
    const geographic = parsed.point.epsg === 4326 || parsed.point.epsg === 4258;
    const maximum = circle ? 1_000 : geographic ? 0.25 : 10_000;
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
    limit: circle ? LIMITS.maxFeatures : parsed.limit,
    properties: parsed.properties,
    filters: parsed.filters
  });

  const features = result.featureCollection.features ?? [];
  if (circle && (result.outputEpsg !== 2056 || (result.evidence?.responseCrs &&
    result.evidence.responseCrs.trim().replace(/^<|>$/g, "") !== CRS[2056]))) {
    throw new GeoBsError("INVALID_UPSTREAM_RESPONSE", "The response CRS conflicts with EPSG:2056; meter distances cannot be calculated.");
  }
  const coverage = candidateCoverage(result);
  const measured = circle ? withinRadius(features, parsed.point!, parsed.point!.radius!) : undefined;
  const selected = measured ? measured.slice(0, parsed.limit) : features.map(feature => ({ feature, distanceMeters: undefined }));
  const matchesInCandidates = measured?.length ?? features.length;
  const reasons = [...coverage.reasons];
  if (selected.length < matchesInCandidates) reasons.push("result_limit");
  const warnings = circle
    ? ["Distances are horizontal air-line meters from the echoed center, not walking distances or times."]
    : ["These are bounding-box candidates, not circle results. Do not label these counts as within a radius."];
  if (!coverage.complete) warnings.push("Candidate coverage is incomplete or unknown; missing features may be closer. No complete or globally nearest list is established.");
  if (circle && !result.evidence?.responseCrs) warnings.push("CRS_HEADER_MISSING: EPSG:2056 is advertised and explicitly requested, but the upstream did not confirm it in a response header.");
  const mapped = {
    collection: {
      id: result.collection.id,
      title: result.collection.title,
      description: compactText(result.collection.description),
      advertisedCrs: result.collection.crs ?? []
    },
    crs: `EPSG:${result.outputEpsg}`,
    source: {
      url: result.evidence?.url ?? `${API_URLS.ogcFeatures}/collections/${encodeURIComponent(parsed.collectionId)}/items`,
      retrievedAt: result.evidence?.retrievedAt ?? new Date().toISOString(),
      upstreamTimestamp: result.featureCollection.timeStamp ?? null,
      dataUpdatedAt: null,
      note: "Retrieval and response timestamps are not a verified feature update date."
    },
    spatial: { mode: parsed.spatialMode, center: parsed.point ?? null, bbox: bbox ?? null,
      bboxEpsg, distanceMethod: circle ? "horizontal_euclidean_EPSG2056" : null,
      crsEvidence: result.evidence?.responseCrs ? "response_header" : "requested_and_advertised_header_absent",
      matchesInCandidates, sortedBy: circle ? "distanceMeters_ascending" : null },
    coverage: { ...coverage, complete: coverage.complete && reasons.length === 0,
      candidatesComplete: coverage.complete, reasons,
      scope: circle ? "circle_in_selected_collection" : "bbox_in_selected_collection" },
    warnings,
    numberMatched: result.featureCollection.numberMatched,
    numberMatchedScope: "upstream_bbox_candidates",
    numberReturned: selected.length,
    features: selected.map(({ feature, distanceMeters }) => ({
      id: feature.id,
      ...(distanceMeters === undefined ? {} : { distanceMeters }),
      properties: feature.properties ?? {},
      bbox: feature.bbox,
      ...(parsed.includeGeometry ? { geometry: feature.geometry } : {})
    }))
  };
  // Final coverage must reflect byte-budget trimming as well as upstream limits.
  return enforceFeatureOutputLimit(mapped, summarize);
}

function summarize(output: { numberReturned: number; collection: { id: string } }): string {
  return `Returned ${output.numberReturned} bounded feature(s) from ${output.collection.id}.`;
}

export function registerQueryFeatures(server: McpServer, client: OgcFeaturesClient) {
  registerReadOnlyTool(server, {
    name: "query_features_ogc",
    title: "Query GeoBS features",
    description:
      "Query live features by exact discovered collection ID. For air-line distances of Point features use spatialMode=circle, point with explicit radius in meters, EPSG:2056; server filters and sorts up to 25 candidates and returns distanceMeters. Copy the previous center exactly for follow-ups. Default bbox is ONLY box candidates, including polygon queries. Cite source and unknown dataUpdatedAt; obey coverage.complete, reasons and warnings. Counts alone do not establish greenery, service quality or an area ranking. Clarify place, radius and comparison criteria before querying. Supports selected properties and five exact filters; no arbitrary URLs.",
    inputSchema: queryFeaturesShape,
    outputSchema: queryFeaturesOutputShape,
    execute: (input) => queryFeatures(client, input),
    summarize
  });
}
