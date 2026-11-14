import { API_URLS } from "../config";
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

interface ItemCollection {
  features?: StacItem[];
  links?: StacLink[];
  numberMatched?: number;
  numberReturned?: number;
}

export const STAC_ITEM_LIMIT = 10;

export interface StacItemsPage {
  items: StacItem[];
  source: { url: string; retrievedAt: string };
  coverage: {
    complete: boolean;
    reasons: string[];
    requestedLimit: number;
    numberReturned: number;
    numberMatched: number | null;
    upstreamNumberReturned: number | null;
    hasNextPage: boolean;
  };
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function validateId(id: string): string {
  const parsed = datasetIdSchema.safeParse(id);
  if (!parsed.success) {
    throw new GeoBsError("INVALID_INPUT", "Invalid STAC dataset ID.");
  }
  return parsed.data;
}

export class StacClient {
  constructor(private readonly fetcher: FetchLike = fetch) {}

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
    return (await this.listItemsPage(id, limit)).items;
  }

  async listItemsPage(id: string, limit = STAC_ITEM_LIMIT): Promise<StacItemsPage> {
    id = validateId(id);
    const safeLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(STAC_ITEM_LIMIT, Math.trunc(limit))) : STAC_ITEM_LIMIT;
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
    const received = response.data.features;
    const items = received.slice(0, safeLimit);
    const numberMatched = count(response.data.numberMatched);
    const upstreamNumberReturned = count(response.data.numberReturned);
    const hasNextPage = Array.isArray(response.data.links) &&
      response.data.links.some(link => link?.rel === "next");
    const reasons: string[] = [];
    if (hasNextPage) reasons.push("next_page");
    if (numberMatched === null) reasons.push("unknown_total");
    else if (numberMatched > items.length) reasons.push("upstream_limit");
    if (received.length > items.length) reasons.push("local_limit");
    if ((response.data.numberMatched != null && numberMatched === null) ||
        (response.data.numberReturned != null && upstreamNumberReturned === null) ||
        (numberMatched !== null && numberMatched < received.length) ||
        (upstreamNumberReturned !== null && upstreamNumberReturned !== received.length)) {
      reasons.push("inconsistent_counts");
    }
    return {
      items,
      source: { url: url.href, retrievedAt: new Date().toISOString() },
      coverage: { complete: reasons.length === 0, reasons, requestedLimit: safeLimit,
        numberReturned: items.length, numberMatched, upstreamNumberReturned, hasNextPage }
    };
  }
}
