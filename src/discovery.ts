import type { OgcCollection } from "./clients/ogcFeatures";
import { datasetIdSchema } from "./schemas";

// GeoBS naming conventions, not a formal STAC/OGC API relationship.
export function findCollectionsForDataset(
  datasetId: string,
  collections: OgcCollection[]
): OgcCollection[] {
  const parsed = datasetIdSchema.safeParse(datasetId);
  if (!parsed.success) return [];
  const code = parsed.data.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
