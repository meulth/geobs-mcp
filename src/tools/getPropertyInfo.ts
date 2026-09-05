import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerReadOnlyTool } from "../mcp/register";
import { pointSchema, propertyIdsSchema } from "../schemas";
import type { OgcFeaturesClient } from "../clients/ogcFeatures";
import { findParcelCollection } from "../discovery";
import type { PropertyInfoClient } from "../clients/propertyInfo";
import { GeoBsError } from "../errors";
import { fitsToolOutput } from "../mcp/results";

const getPropertyInfoShape = {
  ids: propertyIdsSchema.optional().describe("E-GRID or section/parcel IDs."),
  point: pointSchema.optional().describe("A point, normally copied from search_location."),
  withGeometry: z.boolean().default(false)
};

const getPropertyInfoInput = z.object(getPropertyInfoShape);

const getPropertyInfoOutputShape = {
  resolvedFrom: z.object({ type: z.enum(["ids", "point"]) }).catchall(z.json()),
  requestedIds: z.array(z.string()),
  realEstates: z.array(z.record(z.string(), z.json()))
};

function findEgrid(properties: Record<string, unknown> | null | undefined): string | undefined {
  if (!properties) return undefined;
  const entry = Object.entries(properties).find(
    ([key, value]) => key.toLocaleLowerCase("de-CH") === "egrid" && typeof value === "string"
  );
  return entry?.[1] as string | undefined;
}

function stripGeometry(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripGeometry);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key.toLocaleLowerCase("en") !== "geometry")
      .map(([key, child]) => [key, stripGeometry(child)])
  );
}

export async function getPropertyInfo(
  propertyClient: PropertyInfoClient,
  ogcClient: OgcFeaturesClient,
  input: unknown
) {
  const parsed = getPropertyInfoInput.parse(input);
  if ((!parsed.ids && !parsed.point) || (parsed.ids && parsed.point)) {
    throw new GeoBsError(
      "INVALID_INPUT",
      "Provide exactly one of ids or point."
    );
  }

  let ids = parsed.ids;
  let resolvedFrom:
    | { type: "ids" }
    | { type: "point"; point: { x: number; y: number; epsg: number }; collectionId: string } = {
      type: "ids"
    };

  if (parsed.point) {
    const collections = await ogcClient.listCollections();
    const parcelCollection = findParcelCollection(collections);
    if (!parcelCollection) {
      throw new GeoBsError(
        "COLLECTION_NOT_FOUND",
        "No suitable parcel collection could be discovered dynamically."
      );
    }
    const point = parsed.point;
    const lookup = await ogcClient.queryFeatures(parcelCollection.id, {
      bbox: [point.x, point.y, point.x, point.y],
      bboxEpsg: point.epsg,
      outputEpsg: point.epsg,
      limit: 5
    });
    ids = [
      ...new Set(
        (lookup.featureCollection.features ?? [])
          .map((feature) => findEgrid(feature.properties))
          .filter((value): value is string => Boolean(value))
      )
    ];
    if (ids.length === 0) {
      throw new GeoBsError(
        "NO_RESULTS",
        "No E-GRID was found at the supplied point."
      );
    }
    resolvedFrom = {
      type: "point",
      point: { x: point.x, y: point.y, epsg: point.epsg },
      collectionId: parcelCollection.id
    };
  }

  const response = await propertyClient.getInformation(ids!, parsed.withGeometry);
  let output: Record<string, unknown> = {
    resolvedFrom,
    requestedIds: ids,
    crs: parsed.withGeometry ? "EPSG:2056" : undefined,
    date: response.Date,
    realEstates: response.RealEstates
  };
  if (!fitsToolOutput(output, summarize(output))) {
    output = {
      ...(stripGeometry(output) as Record<string, unknown>),
      geometryOmitted: true
    };
  }
  if (!fitsToolOutput(output, summarize(output))) {
    throw new GeoBsError(
      "RESPONSE_TOO_LARGE",
      "The property response is too large even without geometry."
    );
  }
  return output;
}

function summarize(output: Record<string, unknown>): string {
  return `Returned information for ${Array.isArray(output.realEstates) ? output.realEstates.length : 0} real estate(s).`;
}

export function registerGetPropertyInfo(server: McpServer, propertyInfo: PropertyInfoClient, ogc: OgcFeaturesClient) {
  registerReadOnlyTool(server, {
    name: "get_property_info",
    title: "Get Basel-Stadt property information",
    description:
      "Get parcel, building, address and land-cover information from Grundstückinfo. Accepts E-GRID/parcel IDs or a point returned by search_location. Point input dynamically discovers the parcel feature collection and resolves its E-GRID first.",
    inputSchema: getPropertyInfoShape,
    outputSchema: getPropertyInfoOutputShape,
    execute: (input) => getPropertyInfo(propertyInfo, ogc, input),
    summarize
  });
}
