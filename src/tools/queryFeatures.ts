import type { OgcFeaturesClient } from "../clients/ogcFeatures";
import { GeoBsError } from "../errors";
import { compactText, enforceFeatureOutputLimit } from "./output";
import { queryFeaturesInput } from "./schemas";

export async function queryFeatures(
  client: OgcFeaturesClient,
  input: unknown
) {
  const parsed = queryFeaturesInput.parse(input);
  if (parsed.bbox && parsed.point) {
    throw new GeoBsError("INVALID_INPUT", "Provide either bbox or point, not both.");
  }

  let bbox = parsed.bbox;
  let bboxEpsg = parsed.bboxEpsg;
  if (parsed.point) {
    const radius = parsed.point.radius ?? 0;
    const geographic = parsed.point.epsg === 4326 || parsed.point.epsg === 4258;
    const maximum = geographic ? 0.25 : 10_000;
    if (radius > maximum) {
      throw new GeoBsError(
        "INVALID_INPUT",
        `Point radius exceeds the ${maximum} coordinate-unit safety limit for EPSG:${parsed.point.epsg}.`
      );
    }
    bbox = [
      parsed.point.x - radius,
      parsed.point.y - radius,
      parsed.point.x + radius,
      parsed.point.y + radius
    ];
    bboxEpsg = parsed.point.epsg;
  }

  const result = await client.queryFeatures(parsed.collectionId, {
    bbox,
    bboxEpsg,
    outputEpsg: parsed.outputEpsg ?? bboxEpsg,
    limit: parsed.limit,
    properties: parsed.properties,
    filters: parsed.filters
  });

  const features = result.featureCollection.features ?? [];
  const mapped = {
    collection: {
      id: result.collection.id,
      title: result.collection.title,
      description: compactText(result.collection.description),
      advertisedCrs: result.collection.crs ?? []
    },
    crs: `EPSG:${result.outputEpsg}`,
    numberMatched: result.featureCollection.numberMatched,
    numberReturned: features.length,
    features: features.map((feature) => ({
      id: feature.id,
      properties: feature.properties ?? {},
      bbox: feature.bbox,
      ...(parsed.includeGeometry ? { geometry: feature.geometry } : {})
    }))
  };
  return enforceFeatureOutputLimit(mapped);
}
