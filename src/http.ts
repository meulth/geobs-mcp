import { GEOBS_ORIGIN, LIMITS } from "./config";
import { GeoBsError, type GeoBsErrorCode } from "./errors";

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export interface JsonRequestOptions {
  fetcher?: FetchLike;
  headers?: HeadersInit;
  timeoutMs?: number;
  maxBytes?: number;
  notFoundCode?: Extract<
    GeoBsErrorCode,
    "DATASET_NOT_FOUND" | "COLLECTION_NOT_FOUND"
  >;
}

export interface JsonResponse<T> {
  data: T;
  headers: Headers;
  status: number;
}

function assertAllowedUrl(url: URL): void {
  if (url.origin !== GEOBS_ORIGIN || url.protocol !== "https:") {
    throw new GeoBsError(
      "INVALID_INPUT",
      "Only the configured GeoBS API origin is allowed."
    );
  }
}

function statusError(status: number, notFoundCode?: JsonRequestOptions["notFoundCode"]): GeoBsError {
  if (status === 404 && notFoundCode) {
    const message =
      notFoundCode === "DATASET_NOT_FOUND"
        ? "The requested GeoBS dataset was not found."
        : "The requested OGC feature collection was not found.";
    return new GeoBsError(notFoundCode, message);
  }
  if (status === 429) {
    return new GeoBsError(
      "RATE_LIMIT",
      "The GeoBS API rate limit was reached. Try again later.",
      true
    );
  }
  if (status === 401 || status === 403) {
    return new GeoBsError(
      "UPSTREAM_AUTH_ERROR",
      "The GeoBS API rejected the server-side API key."
    );
  }
  if (status >= 500) {
    return new GeoBsError(
      "UPSTREAM_UNAVAILABLE",
      "The GeoBS API is currently unavailable.",
      true
    );
  }
  return new GeoBsError(
    "UPSTREAM_REJECTED",
    `The GeoBS API rejected the request (HTTP ${status}).`
  );
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const tooLarge = () => new GeoBsError(
    "RESPONSE_TOO_LARGE",
    "The GeoBS API response exceeded the configured safety limit."
  );
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function fetchJson<T>(
  url: URL | string,
  options: JsonRequestOptions = {}
): Promise<JsonResponse<T>> {
  const parsedUrl = typeof url === "string" ? new URL(url) : url;
  assertAllowedUrl(parsedUrl);

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? LIMITS.timeoutMs
  );

  try {
    const response = await (options.fetcher ?? fetch)(parsedUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...options.headers
      },
      signal: controller.signal,
      // Workerd intentionally does not implement redirect:"error". Manual mode
      // keeps redirects from being followed; any 3xx is rejected below.
      redirect: "manual"
    });

    if (!response.ok) {
      throw statusError(response.status, options.notFoundCode);
    }

    const body = await readBoundedBody(response, options.maxBytes ?? LIMITS.maxJsonBytes);

    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
      return {
        data: JSON.parse(text) as T,
        headers: response.headers,
        status: response.status
      };
    } catch (error) {
      if (error instanceof GeoBsError) throw error;
      throw new GeoBsError(
        "INVALID_UPSTREAM_RESPONSE",
        "The GeoBS API returned invalid JSON."
      );
    }
  } catch (error) {
    if (error instanceof GeoBsError) throw error;
    if (
      controller.signal.aborted ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      throw new GeoBsError(
        "TIMEOUT",
        "The GeoBS API request timed out.",
        true
      );
    }
    throw new GeoBsError(
      "UPSTREAM_UNAVAILABLE",
      "The GeoBS API could not be reached.",
      true
    );
  } finally {
    clearTimeout(timeout);
  }
}

export function requireApiKey(apiKey?: string): string {
  if (!apiKey?.trim()) {
    throw new GeoBsError(
      "MISSING_API_KEY",
      "GEOBS_API_KEY is not configured on the server."
    );
  }
  return apiKey;
}
