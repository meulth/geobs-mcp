import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerReadOnlyTool } from "../mcp/register";
import { LIMITS } from "../config";
import type { StacClient, StacCollection } from "../clients/stac";
import { GeoBsError } from "../errors";
import { compactText, selectLinks } from "./output";

const searchDatasetsShape = {
  query: z.string().trim().min(2).max(100).describe("German or English dataset topic, title or identifier."),
  limit: z.number().int().min(1).max(LIMITS.maxDatasetResults).default(8)
};

const searchDatasetsInput = z.object(searchDatasetsShape);

const searchDatasetsOutputShape = {
  query: z.string(),
  searchedCollectionCount: z.number().int(),
  resultCount: z.number().int(),
  datasets: z.array(
    z.object({ id: z.string(), title: z.string().optional() }).catchall(z.json())
  )
};

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("de-CH")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function scoreCollection(collection: StacCollection, query: string): number {
  const normalizedQuery = normalize(query);
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const id = normalize(collection.id);
  const title = normalize(collection.title ?? "");
  const keywords = normalize((collection.keywords ?? []).join(" "));
  const description = normalize(collection.description ?? "");
  let score = 0;

  if (id === normalizedQuery) score += 120;
  if (title === normalizedQuery) score += 100;
  if (title.includes(normalizedQuery)) score += 60;
  if (keywords.includes(normalizedQuery)) score += 40;
  if (description.includes(normalizedQuery)) score += 20;

  for (const token of tokens) {
    if (id.includes(token)) score += 15;
    if (title.includes(token)) score += 12;
    if (keywords.includes(token)) score += 8;
    if (description.includes(token)) score += 3;
  }
  return score;
}

export async function searchDatasets(client: StacClient, input: unknown) {
  const parsed = searchDatasetsInput.parse(input);
  const collections = await client.listCollections();
  const ranked = collections
    .map((collection) => ({ collection, score: scoreCollection(collection, parsed.query) }))
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.collection.title ?? a.collection.id).localeCompare(
          b.collection.title ?? b.collection.id,
          "de-CH"
        )
    )
    .slice(0, parsed.limit);

  if (ranked.length === 0) {
    throw new GeoBsError("NO_RESULTS", "No STAC dataset matched the topic.");
  }

  return {
    query: parsed.query,
    searchedCollectionCount: collections.length,
    resultCount: ranked.length,
    datasets: ranked.map(({ collection }) => ({
      id: collection.id,
      title: collection.title,
      description: compactText(collection.description),
      keywords: collection.keywords ?? [],
      extent: collection.extent,
      crs: collection["proj:code"],
      links: selectLinks(collection.links)
    }))
  };
}

function summarize(output: Awaited<ReturnType<typeof searchDatasets>>): string {
  return `Found ${output.resultCount} matching dataset(s) among ${output.searchedCollectionCount} STAC collections.`;
}

export function registerSearchDatasets(server: McpServer, client: StacClient) {
  registerReadOnlyTool(server, {
    name: "search_datasets",
    title: "Search GeoBS datasets",
    description:
      "Search live GeoBS STAC collection metadata by topic, title, keyword or ID. No dataset list is hardcoded. Call get_dataset with a returned ID for assets and feature-collection discovery.",
    inputSchema: searchDatasetsShape,
    outputSchema: searchDatasetsOutputShape,
    execute: (input) => searchDatasets(client, input),
    summarize
  });
}
