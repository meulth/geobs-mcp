import { GeoBsError } from "../errors";
import { fitsToolOutput } from "../mcp/results";

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

export function enforceFeatureOutputLimit<T extends {
  numberReturned: number;
  features: Array<Record<string, unknown>>;
  coverage?: { complete: boolean; reasons: string[] };
}>(
  value: T,
  summarize: (output: T) => string
): T & { geometryOmitted?: boolean; outputTruncated?: boolean } {
  const fits = (output: T) => fitsToolOutput(output, summarize(output));
  if (fits(value)) return value;

  const withoutGeometry = {
    ...value,
    geometryOmitted: true,
    features: value.features.map(({ geometry: _geometry, ...feature }) => feature)
  };
  if (fits(withoutGeometry)) return withoutGeometry;

  const truncated = { ...withoutGeometry, outputTruncated: true,
    ...(value.coverage ? { coverage: { ...value.coverage, complete: false,
      reasons: [...value.coverage.reasons, "output_byte_limit"] } } : {}) };
  while (truncated.features.length > 1 && !fits(truncated)) {
    truncated.features.pop();
    truncated.numberReturned = truncated.features.length;
  }
  if (!fits(truncated)) {
    throw new GeoBsError(
      "RESPONSE_TOO_LARGE",
      "A feature response is too large even without geometry. Select fewer properties."
    );
  }
  return truncated;
}
