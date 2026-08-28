import { LIMITS } from "../config";

export function compactText(value: string | undefined, max = 600): string | undefined {
  if (!value) return value;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function selectLinks(
  links: Array<{ href: string; rel: string; type?: string; title?: string }> | undefined
) {
  return (links ?? [])
    .filter((link) => ["self", "items", "related", "describedby"].includes(link.rel))
    .slice(0, 20)
    .map(({ href, rel, type, title }) => ({ href, rel, type, title }));
}

export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function enforceFeatureOutputLimit<T extends { features: Array<Record<string, unknown>> }>(
  value: T
): T & { geometryOmitted?: boolean; outputTruncated?: boolean } {
  if (jsonByteLength(value) <= LIMITS.maxToolOutputBytes) return value;

  const withoutGeometry = {
    ...value,
    geometryOmitted: true,
    features: value.features.map(({ geometry: _geometry, ...feature }) => feature)
  };
  if (jsonByteLength(withoutGeometry) <= LIMITS.maxToolOutputBytes) return withoutGeometry;

  while (
    withoutGeometry.features.length > 1 &&
    jsonByteLength(withoutGeometry) > LIMITS.maxToolOutputBytes
  ) {
    withoutGeometry.features.pop();
  }
  return { ...withoutGeometry, outputTruncated: true };
}
