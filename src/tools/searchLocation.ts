import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerReadOnlyTool } from "../mcp/register";
import { locationQuerySchema } from "../schemas";
import { LIMITS } from "../config";
import { SEARCH_TYPES } from "../clients/search";
import { GeoBsError } from "../errors";
import { SearchClient, parsePointWkt } from "../clients/search";

const searchLocationShape = {
  query: locationQuerySchema.describe("Address, street, place or other location search text."),
  limit: z.number().int().min(1).max(LIMITS.maxSearchResults).default(8),
  epsg: z.union([z.literal(2056), z.literal(4326)]).default(2056),
  outputFormat: z.enum(["geom", "bbox", "centroid"]).default("geom"),
  types: z.array(z.enum(SEARCH_TYPES)).max(SEARCH_TYPES.length).optional()
};

const searchLocationInput = z.object(searchLocationShape);

const searchLocationOutputShape = {
  query: z.string(),
  crs: z.string(),
  resultCount: z.number().int(),
  results: z.array(
    z.object({
      label: z.string(),
      type: z.string(),
      geometry: z.string(),
      coordinate: z.array(z.number()).length(2).optional()
    }).catchall(z.json())
  )
};

export async function searchLocation(
  client: SearchClient,
  input: unknown
) {
  const parsed = searchLocationInput.parse(input);
  const results = await client.search(parsed.query, {
    limit: parsed.limit,
    epsg: parsed.epsg,
    outputFormat: parsed.outputFormat,
    types: parsed.types
  });
  if (results.length === 0) {
    throw new GeoBsError("NO_RESULTS", "No location matched the search term.");
  }

  return {
    query: parsed.query,
    crs: `EPSG:${parsed.epsg}`,
    resultCount: results.length,
    results: results.map((result) => ({
      label: result.label.trim(),
      type: result.layer_name,
      details: result.details ?? {},
      geometry: result.geom,
      coordinate: parsePointWkt(result.geom)
    }))
  };
}

function summarize(output: Awaited<ReturnType<typeof searchLocation>>): string {
  return `Found ${output.resultCount} location result(s) in ${output.crs}.`;
}

export function registerSearchLocation(server: McpServer, client: SearchClient) {
  registerReadOnlyTool(server, {
    name: "search_location",
    title: "Search a Basel-Stadt location",
    description:
      "Resolve an address, street, place, parcel identifier or other GeoBS search object. Returns reusable coordinates and the CRS. For an address workflow, pass the returned point to get_property_info.",
    inputSchema: searchLocationShape,
    outputSchema: searchLocationOutputShape,
    execute: (input) => searchLocation(client, input),
    summarize
  });
}
