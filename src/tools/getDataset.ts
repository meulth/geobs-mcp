import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerReadOnlyTool } from "../mcp/register";
import { datasetIdSchema } from "../schemas";
import { STAC_ITEM_LIMIT, type StacClient, type StacAsset, type StacItem } from "../clients/stac";
import type { OgcFeaturesClient } from "../clients/ogcFeatures";
import { findCollectionsForDataset } from "../discovery";
import { asGeoBsError } from "../errors";
import { compactText, selectLinks, sourceSummary } from "./output";
import { API_URLS, GEOBS_ORIGIN } from "../config";

const getDatasetShape = {
  id: datasetIdSchema.describe("Known STAC product ID, or stacDatasetId from search_datasets_ogc (inferred from the OGC naming convention). Do not pass the long OGC layer ID.")
};

const getDatasetInput = z.object(getDatasetShape);

const getDatasetOutputShape = {
  id: z.string(),
  title: z.string().optional(),
  source: z.object({ url: z.string(), retrievedAt: z.string(), dataUpdatedAt: z.null(), note: z.string() }),
  itemsSource: z.object({ url: z.string(), retrievedAt: z.string().nullable() }),
  itemsCoverage: z.object({ complete: z.boolean(), reasons: z.array(z.string()),
    requestedLimit: z.number().int(), numberReturned: z.number().int(), numberMatched: z.number().int().nullable(),
    upstreamNumberReturned: z.number().int().nullable(), hasNextPage: z.boolean() }),
  items: z.array(z.object({ id: z.string() }).catchall(z.json())),
  ogcFeaturesDiscovery: z.object({
    totalMatches: z.number().int(),
    collections: z.array(z.object({ id: z.string() }).catchall(z.json()))
  }).catchall(z.json())
};

function isGeoBsFeatureLink(href: string): boolean {
  try {
    const url = new URL(href);
    return url.origin === GEOBS_ORIGIN && url.pathname.startsWith("/ogc/v1/wfs3/collections/");
  } catch {
    return false;
  }
}

function mapAssets(assets: Record<string, StacAsset> | undefined) {
  return Object.entries(assets ?? {}).map(([key, asset]) => ({
    key,
    href: asset.href,
    type: asset.type,
    title: asset.title,
    roles: asset.roles ?? []
  }));
}

function mapItem(item: StacItem) {
  return {
    id: item.id,
    bbox: item.bbox,
    datetime: item.properties?.datetime,
    assets: mapAssets(item.assets),
    links: selectLinks(item.links)
  };
}

export async function getDataset(
  stac: StacClient,
  ogc: OgcFeaturesClient,
  input: unknown
) {
  const parsed = getDatasetInput.parse(input);
  const collection = await stac.getCollection(parsed.id);
  const source = {
    url: new URL(`collections/${encodeURIComponent(parsed.id)}`, API_URLS.stac).href,
    retrievedAt: new Date().toISOString(), dataUpdatedAt: null,
    note: "Retrieval and OGC catalog dates are not a verified dataset update date. Item datetime describes that item, not a verified update date of the entire dataset."
  };
  const [itemsResult, wfsResult] = await Promise.allSettled([
    stac.listItemsPage(parsed.id, STAC_ITEM_LIMIT),
    ogc.listCollections()
  ]);

  const page = itemsResult.status === "fulfilled" ? itemsResult.value : undefined;
  const items = page?.items ?? [];
  const related =
    wfsResult.status === "fulfilled"
      ? findCollectionsForDataset(parsed.id, wfsResult.value)
      : [];
  const allLinks = [
    ...(collection.links ?? []),
    ...items.flatMap((item) => item.links ?? [])
  ];
  // Upstream metadata reaches the model verbatim. Pass only the known link
  // fields, a bounded number of links and only GeoBS-hosted feature links.
  const directWfsLinks = allLinks
    .filter((link) => typeof link.href === "string" && isGeoBsFeatureLink(link.href))
    .slice(0, 20)
    .map(({ href, rel, type, title }) => ({ href, rel, type, title }));

  const warnings: Array<{ source: string; error: string; message: string }> = [];
  if (itemsResult.status === "rejected") {
    const error = asGeoBsError(itemsResult.reason);
    warnings.push({ source: "stac_items", error: error.code, message: error.message });
  }
  if (wfsResult.status === "rejected") {
    const error = asGeoBsError(wfsResult.reason);
    warnings.push({ source: "wfs_discovery", error: error.code, message: error.message });
  }

  return {
    id: collection.id,
    title: collection.title,
    source,
    itemsSource: page?.source ?? {
      url: new URL(`collections/${encodeURIComponent(parsed.id)}/items?limit=${STAC_ITEM_LIMIT}`, API_URLS.stac).href,
      retrievedAt: null
    },
    itemsCoverage: page?.coverage ?? {
      complete: false, reasons: ["upstream_error"], requestedLimit: STAC_ITEM_LIMIT,
      numberReturned: 0, numberMatched: null, upstreamNumberReturned: null, hasNextPage: false
    },
    guidance: "In the final answer cite the source URL and exact dataset ID, state that the dataset update date is unknown, and distinguish item datetime from dataset updates. Report itemsCoverage and warnings: only one page of at most 10 STAC items is loaded, with no automatic pagination. An incomplete item list is not all available downloads. OGC discovery is scoped to the cached catalog; matchesTruncated limits that list too.",
    description: compactText(collection.description, 2_000),
    stacVersion: collection.stac_version,
    license: collection.license,
    keywords: collection.keywords ?? [],
    themes: collection.themes ?? [],
    providers: collection.providers ?? [],
    extent: collection.extent,
    crs: collection["proj:code"],
    assets: mapAssets(collection.assets),
    links: selectLinks(collection.links),
    items: items.map(mapItem),
    ogcFeaturesDiscovery: {
      ...ogc.catalogMetadata,
      directLinks: directWfsLinks,
      method:
        related.length > 0
          ? "Dynamic match: the STAC dataset ID occurs as a delimited dataset-code token in OGC collection IDs."
          : "No dynamic OGC collection match was found.",
      totalMatches: related.length,
      matchesTruncated: related.length > 50,
      collections: related.slice(0, 50).map((entry) => ({
        id: entry.id,
        title: entry.title,
        description: compactText(entry.description),
        extent: entry.extent,
        crs: entry.crs ?? [],
        links: selectLinks(entry.links)
      }))
    },
    warnings
  };
}

function summarize(output: Awaited<ReturnType<typeof getDataset>>): string {
  const coverage = output.itemsCoverage;
  return `Loaded dataset ${output.id}; returned ${coverage.numberReturned} STAC item(s) (request limit ${coverage.requestedLimit}, one page only). ` +
    `Item list complete: ${coverage.complete}${coverage.reasons.length ? ` (${coverage.reasons.join(", ")})` : ""}. ` +
    `Discovered ${output.ogcFeaturesDiscovery.totalMatches} related OGC collection(s)${output.ogcFeaturesDiscovery.matchesTruncated ? " (list truncated to 50)" : ""}. ` +
    (output.warnings.length ? `Partial failures: ${output.warnings.map(warning => `${warning.source}: ${warning.error}`).join("; ")}. ` : "") +
    `Metadata retrieved at ${output.source.retrievedAt}; item datetime is not a verified dataset update date.` + sourceSummary(output.source, "Dataset");
}

export function registerGetDataset(server: McpServer, stac: StacClient, ogc: OgcFeaturesClient) {
  registerReadOnlyTool(server, {
    name: "get_dataset_stac",
    title: "Get a GeoBS dataset",
    description:
      "Get one STAC dataset, its live metadata, download assets, at most 10 items from one page and dynamically related OGC API Features collection IDs from the weekly catalog. Cite source and exact dataset ID in the final answer; the dataset update date is unknown, retrieval/catalog dates and item datetime are not verified dataset update dates. Obey itemsCoverage, warnings and discovery matchesTruncated; never label incomplete items as all downloads. Includes catalog age. Use a known four-character product ID or stacDatasetId returned by search_datasets_ogc. An inferred ID may return DATASET_NOT_FOUND; products without OGC layers remain accessible by known ID.",
    inputSchema: getDatasetShape,
    example: { id: "STNA" },
    outputSchema: getDatasetOutputShape,
    execute: (input) => getDataset(stac, ogc, input),
    summarize
  });
}
