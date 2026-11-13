import { API_URLS } from "../config";
import type { EgridCandidate, Json } from "../clients/oereb";
import type { OgcFeaturesClient } from "../clients/ogcFeatures";

export type PropertyChoiceReader = Pick<OgcFeaturesClient, "listCollections" | "queryFeatures">;

function typeLabel(candidate: EgridCandidate): string | null {
  const texts = candidate.type?.Text;
  if (Array.isArray(texts)) {
    const german = texts.find(value => value && typeof value === "object" && !Array.isArray(value) && value.Language === "de");
    if (german && typeof german === "object" && !Array.isArray(german) && typeof german.Text === "string") return german.Text;
  }
  return typeof candidate.type?.Code === "string" ? candidate.type.Code : null;
}

export async function oerebChoices(
  candidates: EgridCandidate[], point: { x: number; y: number; epsg: 2056 },
  reader?: PropertyChoiceReader
) {
  const details = new Map<string, Array<{ propertyType: string; section: string; parcelNumber: string; source: Record<string, Json> }>>();
  if (reader) {
    try {
      const catalog = await reader.listCollections();
      // Discover current surveying layers by metadata, without an installed ID list.
      // If a role is ambiguous, keep the original OEREB labels instead of guessing.
      const roles = ["Liegenschaft", "Selbstrecht"];
      const collections = roles.flatMap(role => {
        const matches = catalog.filter(c => /amtliche vermessung/i.test(c.title ?? "") &&
          new RegExp(`-\\s*${role}$`, "i").test(c.title ?? ""));
        return matches.length === 1 ? matches : [];
      });
      const results = await Promise.allSettled(collections.map(async collection => ({
        collection, result: await reader.queryFeatures(collection.id, {
          // The OEREB lookup may capture a parcel within one metre of the point.
          bbox: [point.x - 1, point.y - 1, point.x + 1, point.y + 1],
          bboxEpsg: 2056, outputEpsg: 2056, limit: 25,
          properties: ["EGRID", "Grundstücksart", "Sektionsname", "Parzellennummer"]
        })
      })));
      const ids = new Set(candidates.map(candidate => candidate.egrid.toUpperCase()));
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        const { collection, result: response } = result.value;
        for (const feature of response.featureCollection.features ?? []) {
          const p = feature.properties;
          if (!p || typeof p.EGRID !== "string" || !ids.has(p.EGRID.toUpperCase()) ||
            typeof p["Grundstücksart"] !== "string" || typeof p.Sektionsname !== "string" ||
            typeof p.Parzellennummer !== "string") continue;
          const key = p.EGRID.toUpperCase();
          const values = details.get(key) ?? [];
          values.push({ propertyType: p["Grundstücksart"], section: p.Sektionsname, parcelNumber: p.Parzellennummer,
            source: { collectionId: collection.id,
              url: response.evidence?.url ?? `${API_URLS.ogcFeatures}/collections/${encodeURIComponent(collection.id)}`,
              retrievedAt: response.evidence?.retrievedAt ?? new Date().toISOString() } });
          details.set(key, values);
        }
      }
    } catch { /* Enrichment failure must preserve the original choices, not select a property. */ }
  }
  return [...new Map(candidates.map(candidate => [candidate.egrid.toUpperCase(), candidate])).values()].map(candidate => {
    const rows = details.get(candidate.egrid.toUpperCase()) ?? [];
    const signatures = new Set(rows.map(row => JSON.stringify([row.propertyType, row.section, row.parcelNumber])));
    const detail = signatures.size === 1 ? rows[0] : undefined;
    // Conflicting detail records and missing fields are never filled from ID patterns.
    const matching = detail?.parcelNumber === candidate.number ? detail : undefined;
    const propertyType = matching?.propertyType ?? typeLabel(candidate);
    const section = matching?.section ?? null;
    const parcelNumber = candidate.number;
    return {
      egrid: candidate.egrid.toUpperCase(), propertyType, section, parcelNumber, numberingArea: candidate.identDN,
      detailStatus: matching ? "available" as const : "unavailable" as const,
      detailSource: matching?.source ?? null,
      label: `${propertyType ?? "Grundstücksart unbekannt"} – ${section ? `Sektion ${section}` : "Sektion unbekannt"}, Parzelle ${parcelNumber}`
    };
  });
}
