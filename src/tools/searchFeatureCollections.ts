import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { catalogStatus, type CatalogReader } from "../catalog";
import type { OgcCollection } from "../clients/ogcFeatures";
import { GeoBsError } from "../errors";
import { registerReadOnlyTool } from "../mcp/register";
import { compactText, sourceSummary } from "./output";
import { inferStacDatasetId } from "../discovery";
import { API_URLS } from "../config";

const inputShape = {
  query: z.string().trim().min(2).max(300).describe("OGC layer topic, title, description terms or exact collection ID."),
  limit: z.number().int().min(1).max(20).default(8)
};
const inputSchema = z.object(inputShape);
const reasonSchema = z.object({
  field: z.enum(["id", "title", "description"]),
  match: z.enum(["exact", "phrase", "terms"]),
  terms: z.array(z.string())
});
const outputShape = {
  query: z.string(), searchedCollectionCount: z.number().int(),
  totalMatches: z.number().int(), resultCount: z.number().int(), truncated: z.boolean(),
  catalogFetchedAt: z.string(), catalogAgeSeconds: z.number().int(), catalogStale: z.boolean(),
  stacDatasetIdSource: z.literal("ogc_id_naming_convention"),
  collections: z.array(z.object({ id: z.string(), title: z.string().optional(),
    stacDatasetId: z.string().regex(/^[A-Z0-9]{4}$/).optional()
      .describe("Four-character STAC product ID inferred from the OGC ID; not verified against STAC. Use with get_dataset_stac. Omitted when the naming convention does not match."),
    description: z.string().optional(), matchReasons: z.array(reasonSchema) }))
};

function normalize(value: string): string {
  return value.toLocaleLowerCase("de-CH").replace(/ä/g, "ae").replace(/ö/g, "oe")
    .replace(/ü/g, "ue").replace(/ß/g, "ss").normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function rank(collection: OgcCollection, query: string, terms: string[], originalQuery: string) {
  const fields = ["id", "title", "description"] as const;
  const values = fields.map(field => normalize(collection[field] ?? ""));
  if (!terms.every(term => values.some(value => value.includes(term)))) return undefined;
  const matchReasons: z.output<typeof reasonSchema>[] = [];
  let score = 0;
  for (const [index, field] of fields.entries()) {
    const value = values[index]!;
    const matched = terms.filter(term => value.includes(term));
    if (matched.length === 0) continue;
    const match = value === query ? "exact" : value.includes(query) ? "phrase" : "terms";
    score += matched.length * [15, 12, 3][index]! + (match === "terms" ? 0 : [60, 50, 10][index]!);
    matchReasons.push({ field, match, terms: matched });
  }
  // A literal ID always wins; exact titles outrank incidental descriptive matches.
  const tier = collection.id.toLowerCase() === originalQuery.toLowerCase() ? 3
    : values[1] === query ? 2 : values[0] === query ? 1 : 0;
  return { collection, matchReasons, score, tier };
}

export async function searchFeatureCollections(catalog: CatalogReader, input: unknown) {
  const parsed = inputSchema.parse(input);
  const query = normalize(parsed.query);
  if (!query) throw new GeoBsError("INVALID_INPUT", "The search must contain letters or numbers.");
  const terms = [...new Set(query.split(/\s+/))];
  if (terms.length > 20) throw new GeoBsError("INVALID_INPUT", "Use at most 20 search terms.");
  const snapshot = await catalog.get();
  const matches = snapshot.collections.map(row => rank(row, query, terms, parsed.query))
    .filter(row => row !== undefined)
    .sort((a, b) => b.tier - a.tier || b.score - a.score ||
      (a.collection.id < b.collection.id ? -1 : a.collection.id > b.collection.id ? 1 : 0));
  const collections = matches.slice(0, parsed.limit).map(({ collection, matchReasons }) => ({
    id: collection.id, title: compactText(collection.title, 300),
    stacDatasetId: inferStacDatasetId(collection.id),
    description: compactText(collection.description), matchReasons
  }));
  return { query: parsed.query, searchedCollectionCount: snapshot.collectionCount,
    totalMatches: matches.length, resultCount: collections.length,
    truncated: collections.length < matches.length, ...catalogStatus(snapshot),
    source: { url: `${API_URLS.ogcFeatures}/collections?f=json`, dataUpdatedAt: null },
    searchScope: "OGC collection metadata only: all terms in ID/title/description, not feature values, measurements or the complete STAC catalogue.",
    interpretation: "Zero matches mean these terms were not found in this cache. Do not claim data is absent from all GeoBS. Catalog fetch time is not the feature update date. Planning classes are not measurements.",
    stacDatasetIdSource: "ogc_id_naming_convention" as const, collections };
}

export function registerSearchFeatureCollections(server: McpServer, catalog: CatalogReader) {
  registerReadOnlyTool(server, {
    name: "search_datasets_ogc", title: "Search GeoBS feature collections",
    description: "Before an area comparison, ask the user to agree on radius and measurable criteria for 'greener' or 'better transport'; do not silently substitute zone/stop counts. Search weekly OGC metadata by topic, ID, title or description; all terms must match. Returns separate layers, match reasons, catalog age and inferred four-character stacDatasetId. Use id with query_features_ogc; stacDatasetId with get_dataset_stac for metadata/downloads. Product IDs are inferred, not verified against STAC. Zero matches only describe this metadata search, not absent measurements or all GeoBS data. Cite source and distinguish cache age from unknown feature update date.",
    inputSchema: inputShape, outputSchema: outputShape,
    execute: input => searchFeatureCollections(catalog, input),
    summarize: output => `Found ${output.resultCount} of ${output.totalMatches} matching OGC layer(s); catalog fetched ${output.catalogFetchedAt}${output.catalogStale ? " (stale)" : ""}. Only OGC metadata searched, not all GeoBS data.` + sourceSummary(output.source)
  });
}
