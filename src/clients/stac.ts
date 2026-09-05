import { API_URLS, LIMITS } from "../config";
import { GeoBsError } from "../errors";
import { fetchJson, type FetchLike } from "../http";
import { datasetIdSchema } from "../schemas";

export interface StacLink {
  href: string;
  rel: string;
  type?: string;
  title?: string;
  method?: string;
}

export interface StacAsset {
  href: string;
  type?: string;
  title?: string;
  roles?: string[];
}

export interface StacCollection {
  id: string;
  title?: string;
  description?: string;
  type?: string;
  stac_version?: string;
  stac_extensions?: string[];
  license?: string;
  keywords?: string[];
  extent?: unknown;
  providers?: unknown[];
  summaries?: Record<string, unknown>;
  themes?: unknown[];
  assets?: Record<string, StacAsset>;
  links?: StacLink[];
  "proj:code"?: string;
}

export interface StacItem {
  id: string;
  collection?: string;
  bbox?: number[];
  properties?: Record<string, unknown>;
  assets?: Record<string, StacAsset>;
  links?: StacLink[];
}

interface CollectionList {
  collections?: StacCollection[];
  links?: StacLink[];
}

interface ItemCollection {
  features?: StacItem[];
  links?: StacLink[];
  numberMatched?: number;
  numberReturned?: number;
}

function validateId(id: string): string {
  const parsed = datasetIdSchema.safeParse(id);
  if (!parsed.success) {
    throw new GeoBsError("INVALID_INPUT", "Invalid STAC dataset ID.");
  }
  return parsed.data;
}

function assertCollectionList(value: CollectionList): StacCollection[] {
  if (!Array.isArray(value.collections)) {
    throw new GeoBsError(
      "INVALID_UPSTREAM_RESPONSE",
      "The STAC collections response is invalid."
    );
  }
  return value.collections;
}

export class StacClient {
  constructor(private readonly fetcher: FetchLike = fetch) {}

  async listCollections(): Promise<StacCollection[]> {
    const url = new URL("collections", API_URLS.stac);
    const response = await fetchJson<CollectionList>(url, {
      fetcher: this.fetcher,
      timeoutMs: LIMITS.metadataTimeoutMs
    });
    return assertCollectionList(response.data);
  }

  async getCollection(id: string): Promise<StacCollection> {
    id = validateId(id);
    const url = new URL(`collections/${encodeURIComponent(id)}`, API_URLS.stac);
    const response = await fetchJson<StacCollection>(url, {
      fetcher: this.fetcher,
      notFoundCode: "DATASET_NOT_FOUND"
    });
    if (!response.data?.id) {
      throw new GeoBsError(
        "INVALID_UPSTREAM_RESPONSE",
        "The STAC dataset response is invalid."
      );
    }
    return response.data;
  }

  async listItems(id: string, limit = 10): Promise<StacItem[]> {
    id = validateId(id);
    const safeLimit = Math.max(1, Math.min(10, Math.trunc(limit)));
    const url = new URL(
      `collections/${encodeURIComponent(id)}/items`,
      API_URLS.stac
    );
    url.searchParams.set("limit", String(safeLimit));
    const response = await fetchJson<ItemCollection>(url, {
      fetcher: this.fetcher,
      notFoundCode: "DATASET_NOT_FOUND"
    });
    if (!Array.isArray(response.data.features)) {
      throw new GeoBsError(
        "INVALID_UPSTREAM_RESPONSE",
        "The STAC items response is invalid."
      );
    }
    return response.data.features;
  }
}
