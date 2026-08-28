import { McpServer } from "@modelcontextprotocol/server";
import type { Env } from "../config";
import { StacClient } from "../clients/stac";
import { SearchClient } from "../clients/search";
import { OgcFeaturesClient } from "../clients/ogcFeatures";
import { PropertyInfoClient } from "../clients/propertyInfo";
import { errorResult } from "../errors";
import { searchLocation } from "../tools/searchLocation";
import { searchDatasets } from "../tools/searchDatasets";
import { getDataset } from "../tools/getDataset";
import { queryFeatures } from "../tools/queryFeatures";
import { getPropertyInfo } from "../tools/getPropertyInfo";
import {
  getDatasetShape,
  getDatasetOutputShape,
  getPropertyInfoShape,
  getPropertyInfoOutputShape,
  queryFeaturesShape,
  queryFeaturesOutputShape,
  searchDatasetsShape,
  searchDatasetsOutputShape,
  searchLocationShape,
  searchLocationOutputShape
} from "../tools/schemas";

export function successResult(summary: string, output: Record<string, unknown>) {
  // MCP structuredContent is JSON, so remove JavaScript-only undefined values
  // before output-schema validation and transport serialization.
  const structuredContent = JSON.parse(JSON.stringify(output)) as Record<
    string,
    unknown
  >;
  return {
    content: [
      { type: "text" as const, text: summary },
      // Per MCP's TextContent backwards-compatibility guidance (SEP-2106 §4.3),
      // a tool with an outputSchema also serializes its full structured result
      // as text: clients that render only `content` (not `structuredContent`)
      // still receive every value and identifier needed for a follow-up call.
      { type: "text" as const, text: JSON.stringify(structuredContent) }
    ],
    structuredContent
  };
}

export function createGeoBsServer(env: Env) {
  const stac = new StacClient();
  const search = new SearchClient(env.GEOBS_API_KEY);
  const ogc = new OgcFeaturesClient();
  const propertyInfo = new PropertyInfoClient(env.GEOBS_API_KEY);

  const server = new McpServer(
    { name: "geobs-mcp", version: "0.1.0" },
    {
      instructions:
        "GeoBS read-only tools. Use search_location first for addresses. Its coordinates can be passed to get_property_info. Use search_datasets, then get_dataset to discover exact OGC collection IDs before query_features. EPSG:2056 (LV95) is the preferred local CRS."
    }
  );

  server.registerTool(
    "search_location",
    {
      title: "Search a Basel-Stadt location",
      description:
        "Resolve an address, street, place, parcel identifier or other GeoBS search object. Returns reusable coordinates and the CRS. For an address workflow, pass the returned point to get_property_info.",
      inputSchema: searchLocationShape,
      outputSchema: searchLocationOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input) => {
      try {
        const output = await searchLocation(search, input);
        return successResult(
          `Found ${output.resultCount} location result(s) in ${output.crs}.`,
          output
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "search_datasets",
    {
      title: "Search GeoBS datasets",
      description:
        "Search live GeoBS STAC collection metadata by topic, title, keyword or ID. No dataset list is hardcoded. Call get_dataset with a returned ID for assets and feature-collection discovery.",
      inputSchema: searchDatasetsShape,
      outputSchema: searchDatasetsOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input) => {
      try {
        const output = await searchDatasets(stac, input);
        return successResult(
          `Found ${output.resultCount} matching dataset(s) among ${output.searchedCollectionCount} STAC collections.`,
          output
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "get_dataset",
    {
      title: "Get a GeoBS dataset",
      description:
        "Get one STAC dataset, its metadata, download assets, items and dynamically related OGC API Features collection IDs. Use an exact ID returned by search_datasets.",
      inputSchema: getDatasetShape,
      outputSchema: getDatasetOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input) => {
      try {
        const output = await getDataset(stac, ogc, input);
        return successResult(
          `Loaded dataset ${output.id}; discovered ${output.ogcFeaturesDiscovery.totalMatches} related OGC collection(s).`,
          output
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "query_features",
    {
      title: "Query GeoBS features",
      description:
        "Run a bounded read-only OGC API Features query against an exact collection ID returned by get_dataset. Supports bbox or point/radius, advertised CRS, selected output properties and at most five exact property filters. Arbitrary URLs and query strings are not accepted.",
      inputSchema: queryFeaturesShape,
      outputSchema: queryFeaturesOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input) => {
      try {
        const output = await queryFeatures(ogc, input);
        return successResult(
          `Returned ${output.numberReturned} bounded feature(s) from ${output.collection.id}.`,
          output
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "get_property_info",
    {
      title: "Get Basel-Stadt property information",
      description:
        "Get parcel, building, address and land-cover information from Grundstückinfo. Accepts E-GRID/parcel IDs or a point returned by search_location. Point input dynamically discovers the parcel feature collection and resolves its E-GRID first.",
      inputSchema: getPropertyInfoShape,
      outputSchema: getPropertyInfoOutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input) => {
      try {
        const output = await getPropertyInfo(propertyInfo, ogc, input);
        const count = Array.isArray(output.realEstates) ? output.realEstates.length : 0;
        return successResult(`Returned information for ${count} real estate(s).`, output);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  return server;
}
