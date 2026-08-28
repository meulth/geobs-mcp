import {
  API_URLS,
  CRS,
  LIMITS,
  type SupportedEpsg
} from "../config";
import { GeoBsError } from "../errors";
import { fetchJson, type FetchLike } from "../http";

export interface OgcLink {
  href: string;
  rel: string;
  type?: string;
  title?: string;
}

export interface OgcCollection {
  id: string;
  title?: string;
  description?: string;
  extent?: unknown;
  crs?: string[];
  links?: OgcLink[];
}

export interface GeoJsonFeature {
  type: "Feature";
  id?: string | number;
  geometry?: Record<string, unknown> | null;
  properties?: Record<string, unknown> | null;
  bbox?: number[];
}

interface CollectionList {
  collections?: OgcCollection[];
}

interface FeatureCollection {
  type?: string;
  features?: GeoJsonFeature[];
  numberMatched?: number | null;
  numberReturned?: number | null;
  timeStamp?: string;
  links?: OgcLink[];
}

export interface PropertyFilter {
  property: string;
  value: string | number | boolean;
}

export interface FeatureQuery {
  bbox?: [number, number, number, number];
  bboxEpsg?: SupportedEpsg;
  outputEpsg?: SupportedEpsg;
  limit?: number;
  properties?: string[];
  filters?: PropertyFilter[];
}

export interface FeatureQueryResult {
  collection: OgcCollection;
  featureCollection: FeatureCollection;
  outputEpsg: SupportedEpsg;
}

const reservedParameters = new Set([
  "f",
  "limit",
  "bbox",
  "bbox-crs",
  "crs",
  "datetime",
  "properties",
  "map"
]);

function validateCollectionId(id: string): void {
  if (!/^[A-Za-z0-9._-]{1,300}$/.test(id)) {
    throw new GeoBsError("INVALID_INPUT", "Invalid OGC collection ID.");
  }
}

function validatePropertyName(name: string): void {
  if (!/^[\p{L}\p{N} _.-]{1,100}$/u.test(name)) {
    throw new GeoBsError(
      "INVALID_INPUT",
      "Feature property names may only contain letters, numbers, spaces, dots, underscores and hyphens."
    );
  }
}

function validateBbox(bbox: number[]): asserts bbox is [number, number, number, number] {
  if (
    bbox.length !== 4 ||
    bbox.some((value) => !Number.isFinite(value)) ||
    bbox[0]! > bbox[2]! ||
    bbox[1]! > bbox[3]!
  ) {
    throw new GeoBsError(
      "INVALID_INPUT",
      "bbox must contain four finite values ordered as minX,minY,maxX,maxY."
    );
  }
}

export class OgcFeaturesClient {
  constructor(private readonly fetcher: FetchLike = fetch) {}

  async listCollections(): Promise<OgcCollection[]> {
    const url = new URL(`${API_URLS.ogcFeatures}/collections`);
    url.searchParams.set("f", "json");
    const response = await fetchJson<CollectionList>(url, {
      fetcher: this.fetcher,
      timeoutMs: LIMITS.metadataTimeoutMs,
      maxBytes: LIMITS.maxWfsCollectionsBytes
    });
    if (!Array.isArray(response.data.collections)) {
      throw new GeoBsError(
        "INVALID_UPSTREAM_RESPONSE",
        "The OGC collections response is invalid."
      );
    }
    return response.data.collections;
  }

  async getCollection(id: string): Promise<OgcCollection> {
    validateCollectionId(id);
    const url = new URL(
      `${API_URLS.ogcFeatures}/collections/${encodeURIComponent(id)}`
    );
    url.searchParams.set("f", "json");
    const response = await fetchJson<OgcCollection>(url, {
      fetcher: this.fetcher,
      notFoundCode: "COLLECTION_NOT_FOUND"
    });
    if (!response.data?.id) {
      throw new GeoBsError(
        "INVALID_UPSTREAM_RESPONSE",
        "The OGC collection response is invalid."
      );
    }
    return response.data;
  }

  async queryFeatures(
    collectionId: string,
    query: FeatureQuery
  ): Promise<FeatureQueryResult> {
    validateCollectionId(collectionId);
    const collection = await this.getCollection(collectionId);
    const bboxEpsg = query.bboxEpsg ?? 2056;
    const outputEpsg = query.outputEpsg ?? bboxEpsg;
    const supported = new Set(collection.crs ?? []);
    if (!supported.has(CRS[bboxEpsg]) || !supported.has(CRS[outputEpsg])) {
      throw new GeoBsError(
        "INVALID_INPUT",
        `Collection ${collectionId} does not advertise the requested CRS.`
      );
    }

    const limit = Math.max(
      1,
      Math.min(LIMITS.maxFeatures, Math.trunc(query.limit ?? 10))
    );
    const url = new URL(
      `${API_URLS.ogcFeatures}/collections/${encodeURIComponent(collectionId)}/items`
    );
    url.searchParams.set("f", "json");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("crs", CRS[outputEpsg]);

    if (query.bbox) {
      validateBbox(query.bbox);
      url.searchParams.set("bbox", query.bbox.join(","));
      url.searchParams.set("bbox-crs", CRS[bboxEpsg]);
    }

    const properties = [...new Set(query.properties ?? [])];
    if (properties.length > 30) {
      throw new GeoBsError(
        "INVALID_INPUT",
        "At most 30 output properties may be selected."
      );
    }
    for (const property of properties) validatePropertyName(property);
    if (properties.length > 0) {
      url.searchParams.set("properties", properties.join(","));
    }

    const filters = query.filters ?? [];
    if (filters.length > LIMITS.maxPropertyFilters) {
      throw new GeoBsError(
        "INVALID_INPUT",
        `At most ${LIMITS.maxPropertyFilters} exact property filters are allowed.`
      );
    }
    for (const filter of filters) {
      validatePropertyName(filter.property);
      if (reservedParameters.has(filter.property.toLowerCase())) {
        throw new GeoBsError(
          "INVALID_INPUT",
          `The reserved query parameter ${filter.property} cannot be used as a property filter.`
        );
      }
      const value = String(filter.value);
      if (value.length > 200) {
        throw new GeoBsError(
          "INVALID_INPUT",
          "Feature filter values may contain at most 200 characters."
        );
      }
      url.searchParams.append(filter.property, value);
    }

    const response = await fetchJson<FeatureCollection>(url, {
      fetcher: this.fetcher,
      headers: { accept: "application/geo+json" },
      maxBytes: 5_000_000
    });
    if (!Array.isArray(response.data.features)) {
      throw new GeoBsError(
        "INVALID_UPSTREAM_RESPONSE",
        "The OGC feature response is invalid."
      );
    }
    response.data.features = response.data.features.slice(0, limit);
    return { collection, featureCollection: response.data, outputEpsg };
  }
}

export function findCollectionsForDataset(
  datasetId: string,
  collections: OgcCollection[]
): OgcCollection[] {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(datasetId)) return [];
  const code = datasetId.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|_)${code}(?:\\.|$)`, "i");
  return collections.filter((collection) => pattern.test(collection.id));
}

export function findParcelCollection(
  collections: OgcCollection[]
): OgcCollection | undefined {
  return collections
    .map((collection) => {
      const text = `${collection.id} ${collection.title ?? ""} ${
        collection.description ?? ""
      }`.toLocaleLowerCase("de-CH");
      let score = 0;
      if (/(^|[._ ])liegenschaft([._ ]|$)/.test(text)) score += 8;
      if (text.includes("parzellen")) score += 4;
      if (text.includes("rechtliche abgrenzungen")) score += 3;
      if (text.includes("egrid")) score += 2;
      if (text.includes("laufende_aenderung")) score -= 5;
      return { collection, score };
    })
    .filter((candidate) => candidate.score >= 8)
    .sort((a, b) => b.score - a.score)[0]?.collection;
}
