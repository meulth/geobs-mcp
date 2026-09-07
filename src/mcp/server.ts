import { McpServer } from "@modelcontextprotocol/server";
import type { Env } from "../config";
import { StacClient } from "../clients/stac";
import { SearchClient } from "../clients/search";
import { OgcFeaturesClient } from "../clients/ogcFeatures";
import { PropertyInfoClient } from "../clients/propertyInfo";
import { registerSearchLocation } from "../tools/searchLocation";
import { registerGetDataset } from "../tools/getDataset";
import { registerQueryFeatures } from "../tools/queryFeatures";
import { registerGetPropertyInfo } from "../tools/getPropertyInfo";
import { registerSearchFeatureCollections } from "../tools/searchFeatureCollections";
import { KvCatalog, type CatalogReader } from "../catalog";

export function createGeoBsServer(env: Env, catalog: CatalogReader = new KvCatalog(env.OGC_CATALOG)) {
  const server = new McpServer(
    { name: "geobs-mcp", version: "0.1.0" },
    {
      instructions:
        "GeoBS read-only tools. Use search_api_v2 first for addresses, then get_property_info with its coordinates. Use search_datasets_ogc for topic discovery from the weekly OGC cache: pass id to query_features_ogc for live features and inferred stacDatasetId to get_dataset_stac for live STAC products, downloads and related layers. Products without OGC layers are not searchable but get_dataset_stac accepts known product IDs. EPSG:2056 (LV95) is the preferred local CRS."
    }
  );

  const stac = new StacClient();
  const ogc = new OgcFeaturesClient(undefined, catalog);
  registerSearchLocation(server, new SearchClient(env.GEOBS_API_KEY));
  registerGetDataset(server, stac, ogc);
  registerQueryFeatures(server, ogc);
  registerGetPropertyInfo(server, new PropertyInfoClient(env.GEOBS_API_KEY), ogc);
  registerSearchFeatureCollections(server, catalog);
  return server;
}
