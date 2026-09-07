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
import { registerSearchFeatureCollections } from "../tools/searchFeatureCollections";
import { KvCatalog, type CatalogReader } from "../catalog";

export function createGeoBsServer(env: Env, catalog: CatalogReader = new KvCatalog(env.OGC_CATALOG)) {
  const server = new McpServer(
    { name: "geobs-mcp", version: "0.1.0" },
    {
      instructions:
        "GeoBS read-only tools. Use search_location first for addresses, then get_property_info with its coordinates. Use search_feature_collections to find exact OGC layer IDs for query_features. Metadata is cached weekly; features remain live. Use search_datasets/get_dataset for STAC products, downloads and related layers. EPSG:2056 (LV95) is the preferred local CRS."
    }
  );

  const stac = new StacClient();
  const ogc = new OgcFeaturesClient(undefined, catalog);
  registerSearchLocation(server, new SearchClient(env.GEOBS_API_KEY));
  registerSearchDatasets(server, stac);
  registerGetDataset(server, stac, ogc);
  registerQueryFeatures(server, ogc);
  registerGetPropertyInfo(server, new PropertyInfoClient(env.GEOBS_API_KEY), ogc);
  registerSearchFeatureCollections(server, catalog);
  return server;
}
