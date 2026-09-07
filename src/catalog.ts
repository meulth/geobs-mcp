import { z } from "zod";
import { API_URLS, LIMITS } from "./config";
import { asGeoBsError, GeoBsError } from "./errors";
import { fetchJson, type FetchLike } from "./http";
import { collectionIdSchema } from "./schemas";
import { elapsed, recordEvent } from "./telemetry";

export const CATALOG_KEY = "ogc-catalog:v1";
export const CATALOG_URL = `${API_URLS.ogcFeatures}/collections?f=json`;
const DAY = 86_400_000;
export const CATALOG_FRESH_MS = 7 * DAY;
export const CATALOG_MAX_AGE_MS = 14 * DAY;

const collectionSchema = z.object({
  id: collectionIdSchema,
  title: z.string().optional(),
  description: z.string().optional(),
  extent: z.unknown().optional(),
  crs: z.array(z.string()).optional(),
  links: z.array(z.object({ href: z.string(), rel: z.string(),
    type: z.string().optional(), title: z.string().optional() }).passthrough()).optional()
}).passthrough();

const collectionsSchema = z.array(collectionSchema).min(1).max(20_000)
  .refine(rows => new Set(rows.map(row => row.id)).size === rows.length);

const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  fetchedAt: z.iso.datetime(),
  source: z.literal(CATALOG_URL),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  collectionCount: z.number().int().positive(),
  collections: collectionsSchema
}).refine(value => value.collectionCount === value.collections.length);

export type CatalogSnapshot = z.output<typeof snapshotSchema>;
export interface CatalogReader { get(): Promise<CatalogSnapshot> }
export interface CatalogStore {
  get(key: string, type: "text"): Promise<string | null>;
  put(key: string, value: string): Promise<unknown>;
}

export function catalogStatus(snapshot: CatalogSnapshot, now = Date.now()) {
  const age = Math.max(0, now - Date.parse(snapshot.fetchedAt));
  return { catalogFetchedAt: snapshot.fetchedAt,
    catalogAgeSeconds: Math.floor(age / 1000), catalogStale: age > CATALOG_FRESH_MS };
}

export function validateCollections(value: unknown) {
  const result = collectionsSchema.safeParse(value);
  if (!result.success) throw new GeoBsError("INVALID_UPSTREAM_RESPONSE",
    "The OGC catalog must contain valid collections with unique IDs.");
  return result.data;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)])
  );
  return value;
}

export async function createCatalogSnapshot(collections: unknown, now = Date.now()): Promise<CatalogSnapshot> {
  const rows = validateCollections(collections).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(rows)));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return { schemaVersion: 1, fetchedAt: new Date(now).toISOString(), source: CATALOG_URL,
    contentHash: Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, "0")).join(""),
    collectionCount: rows.length, collections: rows };
}

export class KvCatalog implements CatalogReader {
  constructor(private readonly store: CatalogStore | undefined, private readonly now = Date.now) {}

  private async read(): Promise<CatalogSnapshot | null> {
    if (!this.store) throw new GeoBsError("UPSTREAM_UNAVAILABLE", "The OGC catalog cache is not configured.", true);
    const raw = await this.store.get(CATALOG_KEY, "text");
    if (raw === null) return null;
    if (new TextEncoder().encode(raw).length > LIMITS.maxWfsCollectionsBytes) {
      throw new GeoBsError("RESPONSE_TOO_LARGE", "The cached OGC catalog exceeds its size limit.");
    }
    let value: unknown;
    try { value = JSON.parse(raw); } catch {
      throw new GeoBsError("INVALID_UPSTREAM_RESPONSE", "The cached OGC catalog is invalid.");
    }
    const parsed = snapshotSchema.safeParse(value);
    if (!parsed.success || Date.parse(parsed.data.fetchedAt) > this.now() + 60_000) {
      throw new GeoBsError("INVALID_UPSTREAM_RESPONSE", "The cached OGC catalog is invalid.");
    }
    return parsed.data;
  }

  async get(): Promise<CatalogSnapshot> {
    const start = performance.now();
    try {
      const snapshot = await this.read();
      if (!snapshot) throw new GeoBsError("UPSTREAM_UNAVAILABLE", "The OGC catalog cache has not been populated yet.", true);
      const status = catalogStatus(snapshot, this.now());
      if (this.now() - Date.parse(snapshot.fetchedAt) > CATALOG_MAX_AGE_MS) {
        throw new GeoBsError("UPSTREAM_UNAVAILABLE", "The OGC catalog cache is older than 14 days and needs a refresh.", true);
      }
      recordEvent({ event: "catalog_cache", outcome: "success", duration_ms: elapsed(start),
        catalog_age_seconds: status.catalogAgeSeconds, catalog_stale: status.catalogStale,
        collection_count: snapshot.collectionCount });
      return snapshot;
    } catch (error) {
      recordEvent({ event: "catalog_cache", outcome: "error", duration_ms: elapsed(start), error_code: asGeoBsError(error).code });
      throw error;
    }
  }

  async refresh(fetcher: FetchLike = fetch): Promise<CatalogSnapshot> {
    const start = performance.now();
    try {
      // No public request can call this path. A failed read also prevents an
      // unchecked replacement of an existing snapshot.
      const previous = await this.read();
      const response = await fetchJson<{ collections?: unknown; links?: Array<{ rel?: string }> }>(CATALOG_URL, {
        fetcher, timeoutMs: LIMITS.metadataTimeoutMs, maxBytes: LIMITS.maxWfsCollectionsBytes
      });
      if (response.data.links?.some(link => link.rel === "next")) {
        throw new GeoBsError("INVALID_UPSTREAM_RESPONSE", "The OGC catalog is paginated; refusing an incomplete replacement.");
      }
      const snapshot = await createCatalogSnapshot(response.data.collections, this.now());
      if (previous && (snapshot.collectionCount < previous.collectionCount * 0.5 || snapshot.collectionCount > previous.collectionCount * 2)) {
        throw new GeoBsError("INVALID_UPSTREAM_RESPONSE", "The OGC catalog count changed unexpectedly; manual review is required.");
      }
      const body = JSON.stringify(snapshot);
      const bytes = new TextEncoder().encode(body).length;
      if (bytes > LIMITS.maxWfsCollectionsBytes) throw new GeoBsError("RESPONSE_TOO_LARGE", "The OGC catalog snapshot exceeds its size limit.");
      await this.store!.put(CATALOG_KEY, body);
      recordEvent({ event: "catalog_refresh", outcome: "success", duration_ms: elapsed(start),
        collection_count: snapshot.collectionCount, snapshot_bytes: bytes,
        changed: previous?.contentHash !== snapshot.contentHash });
      return snapshot;
    } catch (error) {
      recordEvent({ event: "catalog_refresh", outcome: "error", duration_ms: elapsed(start), error_code: asGeoBsError(error).code });
      throw error;
    }
  }
}

export function isCatalogRefreshTime(scheduledTime: number): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Zurich",
    weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(scheduledTime);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return values.weekday === "Wed" && values.hour === "03" && values.minute === "00";
}
