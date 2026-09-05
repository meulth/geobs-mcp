import { McpServer } from "@modelcontextprotocol/server";
import type { Env } from "../config";
import { StacClient } from "../clients/stac";
import { SearchClient } from "../clients/search";
import { OgcFeaturesClient } from "../clients/ogcFeatures";
import { PropertyInfoClient } from "../clients/propertyInfo";
import { registerSearchLocation } from "../tools/searchLocation";
import { registerSearchDatasets } from "../tools/searchDatasets";
import { registerGetDataset } from "../tools/getDataset";
import { registerQueryFeatures } from "../tools/queryFeatures";
import { registerGetPropertyInfo } from "../tools/getPropertyInfo";

export function createGeoBsServer(env: Env) {
  const server = new McpServer(
    { name: "geobs-mcp", version: "0.1.0" },
    {
      instructions:
        "GeoBS read-only tools. Use search_location first for addresses. Its coordinates can be passed to get_property_info. Use search_datasets, then get_dataset to discover exact OGC collection IDs before query_features. EPSG:2056 (LV95) is the preferred local CRS."
    }
  );

  const stac = new StacClient();
  const ogc = new OgcFeaturesClient();
  registerSearchLocation(server, new SearchClient(env.GEOBS_API_KEY));
  registerSearchDatasets(server, stac);
  registerGetDataset(server, stac, ogc);
  registerQueryFeatures(server, ogc);
  registerGetPropertyInfo(server, new PropertyInfoClient(env.GEOBS_API_KEY), ogc);
  return server;
}
