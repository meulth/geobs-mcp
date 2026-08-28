import { API_URLS, LIMITS } from "../config";
import { GeoBsError } from "../errors";
import { fetchJson, requireApiKey, type FetchLike } from "../http";

export interface PropertyInfoResponse {
  Date?: string;
  Service?: unknown;
  RealEstates?: Array<Record<string, unknown>>;
}

function validateIds(ids: string[]): string[] {
  if (ids.length < 1 || ids.length > LIMITS.maxPropertyIds) {
    throw new GeoBsError(
      "INVALID_INPUT",
      `Provide between 1 and ${LIMITS.maxPropertyIds} property IDs.`
    );
  }
  const normalized = ids.map((id) => id.trim().toUpperCase());
  if (normalized.some((id) => !/^[A-Z0-9-]{2,40}$/.test(id))) {
    throw new GeoBsError(
      "INVALID_INPUT",
      "Property IDs must be E-GRIDs or section/parcel identifiers."
    );
  }
  return [...new Set(normalized)];
}

export class PropertyInfoClient {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetcher: FetchLike = fetch
  ) {}

  async getInformation(
    ids: string[],
    withGeometry = false
  ): Promise<PropertyInfoResponse> {
    const apiKey = requireApiKey(this.apiKey);
    const safeIds = validateIds(ids);
    const url = new URL(`${API_URLS.propertyInfo}/realestatesinformation`);
    url.searchParams.set("ids", safeIds.join(","));
    url.searchParams.set("withgeometry", String(withGeometry));
    const response = await fetchJson<PropertyInfoResponse>(url, {
      fetcher: this.fetcher,
      headers: { apikey: apiKey },
      maxBytes: 5_000_000
    });
    if (!Array.isArray(response.data.RealEstates)) {
      throw new GeoBsError(
        "INVALID_UPSTREAM_RESPONSE",
        "The Grundstückinfo response is invalid."
      );
    }
    if (response.data.RealEstates.length === 0) {
      throw new GeoBsError(
        "NO_RESULTS",
        "No property information was found for the supplied ID."
      );
    }
    return response.data;
  }
}
