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
        "GeoBS read-only tools. Ask a short clarification before choosing an ambiguous station/place, an unspecified 'here', radius, topic or comparison criterion. Never invent a location or silently select the first of multiple addresses. Resolve addresses with search_api_v2, then use the returned exact coordinates for get_property_info or query_features_ogc. An address point is not a verified entrance: disclose this approximation. Preserve the exact center and CRS in follow-up queries; compare the echoed center with the previous response. " +
        "Use search_datasets_ogc for discovery from the weekly OGC metadata cache. All terms must match; simplify a failed query once before reporting the bounded search gap. A zero result proves only that these metadata terms did not match, not that GeoBS or the world has no such data. Use exact returned id for live features and inferred stacDatasetId for get_dataset_stac metadata/downloads. " +
        "For Point-feature radius questions use query_features_ogc spatialMode=circle with EPSG:2056. Report returned distanceMeters; do not recalculate them from a guessed center. Circle mode filters and sorts only the bounded loaded candidates. Obey coverage.complete and reasons: missing candidates may be closer. Default bbox is a rectangular candidate query, never a circle count. Do not work around a partial page with unbounded subdivision. Complete property-filtered subsets do not prove complete unfiltered coverage: require reconciliation of unique candidate IDs with the original unfiltered total, including null/unknown categories, before any union completeness claim. Otherwise report a partial list. Distinguish individual feature points from grouped station names. No walking times or routing claims. " +
        "Cite returned source URLs and exact collection IDs or E-GRIDs; state when the feature update date is unknown. Cache/retrieval/response dates are not feature update dates. Use property response links where relevant without claiming a full legal dossier. Before comparing areas agree on equal areas and explicit measurable criteria; a planning zone is not measured greenery, and stop counts are not transport quality. With incomplete data report only bounded observations, not winners or global rankings. Distinguish planning classes from observed measurements and never invent a missing measurement."
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
