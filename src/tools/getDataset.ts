import type { StacClient, StacAsset, StacItem } from "../clients/stac";
import {
  findCollectionsForDataset,
  type OgcFeaturesClient
} from "../clients/ogcFeatures";
import { asGeoBsError } from "../errors";
import { compactText, selectLinks } from "./output";
import { getDatasetInput } from "./schemas";

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
  const [itemsResult, wfsResult] = await Promise.allSettled([
    stac.listItems(parsed.id, 10),
    ogc.listCollections()
  ]);

  const items = itemsResult.status === "fulfilled" ? itemsResult.value : [];
  const related =
    wfsResult.status === "fulfilled"
      ? findCollectionsForDataset(parsed.id, wfsResult.value)
      : [];
  const allLinks = [
    ...(collection.links ?? []),
    ...items.flatMap((item) => item.links ?? [])
  ];
  const directWfsLinks = allLinks.filter((link) =>
    /\/ogc\/v1\/wfs3\/collections\//i.test(link.href)
  );

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
        links: entry.links ?? []
      }))
    },
    warnings
  };
}
