import { API_URLS, LIMITS, type SupportedEpsg } from "../config";
import { GeoBsError } from "../errors";
import { fetchJson, requireApiKey, type FetchLike } from "../http";
import { locationQuerySchema } from "../schemas";

export const SEARCH_TYPES = [
  "Adresse",
  "Adress ID",
  "Basel Info (BI)",
  "E-GRID",
  "Gebäude ID",
  "Haltestelle öffentlicher Verkehr",
  "Parzellennummer",
  "Strasse, Platz, Park",
  "Eidg. Gebäude ID"
] as const;

export type SearchType = (typeof SEARCH_TYPES)[number];
export type SearchOutputFormat = "geom" | "bbox" | "centroid";

export interface SearchResult {
  label: string;
  layer_name: string;
  details?: Record<string, unknown>;
  geom: string;
}

export interface SearchOptions {
  limit?: number;
  partitionLimit?: number;
  outputFormat?: SearchOutputFormat;
  epsg?: Extract<SupportedEpsg, 2056 | 4326>;
  types?: SearchType[];
}

export class SearchClient {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetcher: FetchLike = fetch
  ) {}

  async search(term: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const query = term.trim();
    if (!locationQuerySchema.safeParse(query).success) {
      throw new GeoBsError(
        "INVALID_INPUT",
        "Search terms must contain between 2 and 200 characters."
      );
    }

    const apiKey = requireApiKey(this.apiKey);
    const limit = Math.max(
      1,
      Math.min(LIMITS.maxSearchResults, Math.trunc(options.limit ?? 8))
    );
    const partitionLimit = Math.max(
      1,
      Math.min(limit, Math.trunc(options.partitionLimit ?? limit))
    );
    const outputFormat = options.outputFormat ?? "geom";
    const epsg = options.epsg ?? 2056;

    const url = new URL(`${API_URLS.search}/search`);
    url.searchParams.set("term", query);
    url.searchParams.set("maxresults", String(limit));
    url.searchParams.set("partitionlimit", String(partitionLimit));
    url.searchParams.set("outputformat", outputFormat);
    url.searchParams.set("epsg", String(epsg));
    for (const type of options.types ?? []) {
      url.searchParams.append("type", type);
    }

    const response = await fetchJson<unknown>(url, {
      fetcher: this.fetcher,
      headers: { apikey: apiKey }
    });
    if (!Array.isArray(response.data)) {
      throw new GeoBsError(
        "INVALID_UPSTREAM_RESPONSE",
        "The GeoBS Search API response is invalid."
      );
    }

    const results = response.data.filter(
      (item): item is SearchResult =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as SearchResult).label === "string" &&
        typeof (item as SearchResult).layer_name === "string" &&
        typeof (item as SearchResult).geom === "string"
    );
    if (results.length !== response.data.length) {
      throw new GeoBsError(
        "INVALID_UPSTREAM_RESPONSE",
        "The GeoBS Search API returned an unexpected result structure."
      );
    }
    return results.slice(0, limit);
  }
}

export function parsePointWkt(wkt: string): [number, number] | undefined {
  const match = /^POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)$/i.exec(
    wkt
  );
  if (!match?.[1] || !match[2]) return undefined;
  return [Number(match[1]), Number(match[2])];
}
