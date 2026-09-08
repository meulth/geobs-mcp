import type { FeatureQueryResult, GeoJsonFeature } from "../clients/ogcFeatures";
import { GeoBsError } from "../errors";

/** One bounded candidate page. A full page alone never proves truncation. */
export function candidateCoverage(result: FeatureQueryResult) {
  const kept = result.featureCollection.features?.length ?? 0;
  const raw = result.evidence?.rawCount ?? kept;
  const matched = result.featureCollection.numberMatched;
  const reported = result.featureCollection.numberReturned;
  const reasons: string[] = [];
  if (result.evidence?.hasNext || result.featureCollection.links?.some(link => link.rel === "next")) reasons.push("next_page");
  if (result.evidence?.locallyTruncated) reasons.push("candidate_limit");
  if (typeof matched !== "number" || !Number.isSafeInteger(matched) || matched < 0) {
    reasons.push("unknown_total");
  } else if (matched > raw) reasons.push("upstream_limit");
  else if (matched < raw) reasons.push("inconsistent_counts");
  if (reported != null && (!Number.isSafeInteger(reported) || reported !== raw)) reasons.push("inconsistent_counts");
  return { complete: reasons.length === 0, reasons: [...new Set(reasons)], candidatesReceived: kept,
    candidatesMatched: typeof matched === "number" && Number.isSafeInteger(matched) && matched >= 0 ? matched : null };
}

/** Horizontal LV95 distance; no rounding before filtering or sorting. */
export function withinRadius(features: GeoJsonFeature[], center: { x: number; y: number }, radius: number) {
  return features.map((feature, index) => {
    const coordinates = feature.geometry?.coordinates;
    if (feature.geometry?.type !== "Point" || !Array.isArray(coordinates) ||
      (coordinates.length !== 2 && coordinates.length !== 3) ||
      !coordinates.every(value => typeof value === "number" && Number.isFinite(value))) {
      throw new GeoBsError("INVALID_UPSTREAM_RESPONSE",
        "Circle queries require valid Point geometries. This page contains unsupported or missing geometry; no circle result can be claimed. Use spatialMode=bbox only for explicitly labelled box candidates.");
    }
    const distanceMeters = Math.hypot(coordinates[0] - center.x, coordinates[1] - center.y);
    const key = feature.id === undefined ? "" : `${typeof feature.id}:${feature.id}`;
    return { feature, distanceMeters, key, index };
  }).filter(row => row.distanceMeters <= radius)
    .sort((a, b) => a.distanceMeters - b.distanceMeters ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || a.index - b.index);
}
